import Docker from 'dockerode';
import { Writable } from 'node:stream';
import * as tar from 'tar-stream';

export type SandboxVerdict = 'AC' | 'WA' | 'TLE' | 'CE';

export interface SandboxResult {
  verdict: SandboxVerdict;
  output?: string;
  compileError?: string;
}

const docker = new Docker();

const COMPILE_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 2_000;
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
    // Kills the whole container cgroup (compile process, run process, keep-alive
    // shell) — there is no separate way to kill just this exec.
    await container.kill().catch(() => {});
    return 'timeout';
  }
  return result;
}

export async function runInSandbox(
  code: string,
  input: string,
  expectedOutput: string,
): Promise<SandboxResult> {
  const container = await docker.createContainer({
    Image: 'gcc:12-bookworm',
    // Bounded keep-alive process: if the worker crashes mid-job, the container
    // self-terminates after 60s instead of leaking forever. It is not itself a
    // step timeout — compile/run timeouts are enforced separately below.
    Cmd: ['sh', '-c', 'sleep 60'],
    HostConfig: {
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024, // equal to Memory: no additional swap
      NanoCpus: 1_000_000_000, // 1 CPU
      NetworkMode: 'none',
      PidsLimit: 64, // caps fork-bombs
      AutoRemove: false,
    },
  });

  try {
    await container.start();

    const tarBuffer = await buildTar([
      { name: 'main.cpp', content: code },
      { name: 'input.txt', content: input },
    ]);
    await container.putArchive(tarBuffer, { path: '/tmp' });

    const compile = await execWithTimeout(
      container,
      ['sh', '-c', 'g++ -O2 -o /tmp/a.out /tmp/main.cpp'],
      COMPILE_TIMEOUT_MS,
    );
    if (compile === 'timeout') {
      return { verdict: 'CE', compileError: 'compilation timed out' };
    }
    if (compile.exitCode !== 0) {
      return { verdict: 'CE', compileError: compile.stderr || compile.stdout };
    }

    const run = await execWithTimeout(
      container,
      ['sh', '-c', '/tmp/a.out < /tmp/input.txt'],
      RUN_TIMEOUT_MS,
    );
    if (run === 'timeout') {
      return { verdict: 'TLE' };
    }

    // A non-timeout nonzero exit code (e.g. a segfault) is folded into WA rather
    // than a separate RE verdict, since only AC/WA/TLE/CE are supported here.
    // TODO(ARCHITECTURE.md): introduce a dedicated RE verdict instead of folding
    // runtime crashes into WA.
    const verdict: SandboxVerdict = run.stdout.trim() === expectedOutput.trim() ? 'AC' : 'WA';
    return { verdict, output: run.stdout };
  } finally {
    // TODO(ARCHITECTURE.md): cap captured stdout/stderr size — currently
    // unbounded, so a program that prints gigabytes is read fully into memory.
    // TODO(ARCHITECTURE.md): harden the container with ReadonlyRootfs + a tmpfs
    // mount for /tmp and a non-root User instead of running as root on a
    // writable filesystem.
    await container.remove({ force: true }).catch(() => {});
  }
}
