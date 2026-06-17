import { Skeleton } from "@/components/ui/skeleton";

/**
 * Settings loading fallback (task 6.3). Mirrors the profile page — header, intro, and the
 * name/username form fields — while the profile loads.
 */
export default function Loading() {
  return (
    <div className="flex flex-1 flex-col">
      <p className="sr-only" role="status">
        Loading settings…
      </p>
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-5 w-28" />
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-5 py-12 sm:px-8">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-7 w-40" />
        <Skeleton className="mt-3 h-4 w-full" />
        <div className="mt-8 space-y-6">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-11 w-full rounded-xl" />
            </div>
          ))}
          <Skeleton className="h-11 w-32 rounded-xl" />
        </div>
      </main>
    </div>
  );
}
