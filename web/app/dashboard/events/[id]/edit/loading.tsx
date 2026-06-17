import { Skeleton } from "@/components/ui/skeleton";

/**
 * Edit event loading fallback (task 6.3). Mirrors the page's intro (back link, title) and
 * a form silhouette while the host's event loads over their own RLS path.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
      <p className="sr-only" role="status">
        Loading event…
      </p>
      <Skeleton className="h-4 w-28" />
      <Skeleton className="mt-6 h-3 w-20" />
      <Skeleton className="mt-3 h-9 w-2/3" />
      <div className="mt-10 space-y-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  );
}
