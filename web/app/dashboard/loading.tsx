import { Skeleton } from "@/components/ui/skeleton";

/**
 * Dashboard loading fallback (task 6.3). Mirrors the "your events" silhouette — header,
 * title row, and a few event cards — so the feed's brief server render reads as
 * responding. The skeletons are decorative; the status line carries the announcement.
 */
export default function Loading() {
  return (
    <div className="flex flex-1 flex-col">
      <p className="sr-only" role="status">
        Loading your events…
      </p>
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-8 w-24 rounded-lg" />
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-8 w-44" />
          </div>
          <Skeleton className="h-11 w-28 rounded-xl" />
        </div>
        <div className="mt-10 space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      </main>
    </div>
  );
}
