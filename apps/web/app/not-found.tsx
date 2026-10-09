import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-3 pt-16 text-center">
      <h1 className="text-lg font-semibold">Not Found</h1>
      <p className="text-sm text-ink-muted">This record does not exist, or it belongs to a branch you do not have access to.</p>
      <Link href="/operations" className="text-sm text-accent hover:underline">
        Back to operations
      </Link>
    </div>
  );
}
