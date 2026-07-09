export function ErrorState({ message }: { message: string }) {
  return (
    <div className="border border-verdict-wa bg-verdict-wa/10 px-3 py-2 font-body text-sm text-verdict-wa">
      {message}
    </div>
  );
}
