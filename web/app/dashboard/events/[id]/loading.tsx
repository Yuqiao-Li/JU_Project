import { Skeleton } from "@/components/ui/skeleton";

/**
 * Host event detail loading fallback (task 6.3). Mirrors the management view — back link,
 * title, the share-link card, the stats row, and the guest list — while the host's own
 * RLS reads stream in.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
      <p className="sr-only" role="status">
        Loading event…
      </p>
      <Skeleton className="h-4 w-28" />
      <Skeleton className="mt-6 h-3 w-24" />
      <Skeleton className="mt-3 h-9 w-2/3" />
      <Skeleton className="mt-3 h-4 w-40" />
      <Skeleton className="mt-8 h-24 w-full rounded-2xl" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="mt-10 h-3 w-24" />
      <Skeleton className="mt-4 h-40 w-full rounded-xl" />
    </div>
  );
}
