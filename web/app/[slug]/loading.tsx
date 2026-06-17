import { Skeleton } from "@/components/ui/skeleton";

/**
 * Public event page loading fallback (task 6.3). Mirrors the event silhouette — the hero
 * poster, the headcount chips, and the first content sections — so a guest opening an
 * invite link sees the shape of the page immediately while the trusted-role read streams
 * in. First tier only, same as the real render: nothing here implies an address or list.
 */
export default function Loading() {
  return (
    <div className="flex min-h-full flex-col">
      <article className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-8 sm:py-14">
        <p className="sr-only" role="status">
          Loading event…
        </p>
        <Skeleton className="h-60 w-full rounded-3xl sm:h-72" />
        <div className="mt-6 flex flex-wrap gap-2.5">
          <Skeleton className="h-9 w-24 rounded-full" />
          <Skeleton className="h-9 w-28 rounded-full" />
        </div>
        <div className="mt-8 space-y-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="mt-8 space-y-2.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
        <Skeleton className="mt-10 h-44 w-full rounded-2xl" />
      </article>
    </div>
  );
}
