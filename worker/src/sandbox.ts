import Docker from 'dockerode';
import { Writable } from 'node:stream';
import * as tar from 'tar-stream';

export interface CompileSuccess {
  ok: true;
  binaryTar: Buffer;
}
export interface CompileFailure {
  ok: false;
  compileError: string;
}
export type CompileResult = CompileSuccess | CompileFailure;

export type RunResult =
  | { kind: 'timeout' }
  | { kind: 'oom' }
  | { kind: 'exited'; exitCode: number; stdout: string; stderr: string };

export interface RunLimits {
  timeLimitMs: number;
  memoryLimitMb: number;
}

const docker = new Docker();

const COMPILE_TIMEOUT_MS = 10_000;
const COMPILE_MEMORY_MB = 512; // decoupled from the problem's runtime memory limit
const POLL_INTERVAL_MS = 50;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function buildTar(entries: { name: string; content: string }[]): Promise<Buffer> {
  const pack = tar.pack();
  for (const entry of entries) {
    pack.entry({ name: entry.name }, entry.content);
  }
  pack.finalize();

  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
  });
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Input is placed into the container via putArchive and read from a file,
// never through a written-then-closed stdin stream: a hijacked exec's stdin
// stream on this daemon connection closes the whole exec (dropping any output
// produced after that point) the instant `.end()` is called, before the
// process has actually finished. Polling exec.inspect() for completion
// sidesteps the same early 'end'/'close' event unreliability.
async function execNoStdin(container: Docker.Container, cmd: string[]): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  docker.modem.demuxStream(
    stream,
    new Writable({
      write(chunk, _enc, cb) {
        stdoutChunks.push(chunk);
        cb();
      },
    }),
    new Writable({
      write(chunk, _enc, cb) {
        stderrChunks.push(chunk);
        cb();
      },
    }),
  );

  let info = await exec.inspect();
  while (info.Running) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    info = await exec.inspect();
  }
  // Let the demux stream flush anything already buffered before we read it.
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    exitCode: info.ExitCode ?? -1,
  };
}

async function execWithTimeout(
  container: Docker.Container,
  cmd: string[],
  timeoutMs: number,
): Promise<ExecResult | 'timeout'> {
  const timedOut = Symbol('timeout');
  const result = await Promise.race([
    execNoStdin(container, cmd),
    new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
  ]);

  if (result === timedOut) {
    // Kills the whole container cgroup (the exec'd process, plus the keep-alive
    // shell) — there is no separate way to kill just this exec.
    await container.kill().catch(() => {});
    return 'timeout';
  }
  return result;
}

function createSandboxContainer(memoryLimitMb: number) {
  return docker.createContainer({
    Image: 'gcc:12-bookworm',
    // Bounded keep-alive process: if the worker crashes mid-job, the container
    // self-terminates after 60s instead of leaking forever. It is not itself a
    // step timeout — compile/run timeouts are enforced separately below.
    Cmd: ['sh', '-c', 'sleep 60'],
    HostConfig: {
      Memory: memoryLimitMb * 1024 * 1024,
      MemorySwap: memoryLimitMb * 1024 * 1024, // equal to Memory: no additional swap
      NanoCpus: 1_000_000_000, // 1 CPU
      NetworkMode: 'none',
      PidsLimit: 64, // caps fork-bombs
      AutoRemove: false,
    },
  });
}

export async function compileCode(code: string): Promise<CompileResult> {
  const container = await createSandboxContainer(COMPILE_MEMORY_MB);

  try {
    await container.start();

    const tarBuffer = await buildTar([{ name: 'main.cpp', content: code }]);
    await container.putArchive(tarBuffer, { path: '/tmp' });

    const compile = await execWithTimeout(
      container,
      ['sh', '-c', 'g++ -O2 -o /tmp/a.out /tmp/main.cpp'],
      COMPILE_TIMEOUT_MS,
    );
    if (compile === 'timeout') {
      return { ok: false, compileError: 'compilation timed out' };
    }
    if (compile.exitCode !== 0) {
      return { ok: false, compileError: compile.stderr || compile.stdout };
    }

    const archiveStream = await container.getArchive({ path: '/tmp/a.out' });
    const binaryTar = await streamToBuffer(archiveStream);
    return { ok: true, binaryTar };
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

// Per ARCHITECTURE.md §6, every run happens in a fresh Docker container — so
// this creates one container per test case rather than reusing a single
// container across a submission's tests. Tradeoff: container create/start
// latency (tens-to-low-hundreds of ms) is paid per test instead of once per
// submission. TODO(ARCHITECTURE.md): pool/reuse sandbox containers across
// tests once this becomes a bottleneck — not needed at current problem sizes.
export async function runTest(
  binaryTar: Buffer,
  input: string,
  limits: RunLimits,
): Promise<RunResult> {
  const container = await createSandboxContainer(limits.memoryLimitMb);

  try {
    await container.start();

    await container.putArchive(binaryTar, { path: '/tmp' });
    const inputTar = await buildTar([{ name: 'input.txt', content: input }]);
    await container.putArchive(inputTar, { path: '/tmp' });

    const run = await execWithTimeout(
      container,
      ['sh', '-c', '/tmp/a.out < /tmp/input.txt'],
      limits.timeLimitMs,
    );
    if (run === 'timeout') {
      return { kind: 'timeout' };
    }

    const info = await container.inspect();
    if (info.State.OOMKilled) {
      return { kind: 'oom' };
    }

    return { kind: 'exited', exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
  } finally {
    // TODO(ARCHITECTURE.md): cap captured stdout/stderr size — currently
    // unbounded, so a program that prints gigabytes is read fully into memory.
    // TODO(ARCHITECTURE.md): harden the container with ReadonlyRootfs + a tmpfs
    // mount for /tmp and a non-root User instead of running as root on a
    // writable filesystem.
    await container.remove({ force: true }).catch(() => {});
  }
}
