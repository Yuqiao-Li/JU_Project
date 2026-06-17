import { getTranslations } from "next-intl/server";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * Organizer profile loading fallback (task 6.3). Mirrors the `/u/[username]` silhouette —
 * header, the monogram + handle, and a card grid — so the public events read streams into
 * a shape the visitor already recognizes.
 */
export default async function Loading() {
  const t = await getTranslations("organizer");
  return (
    <div className="flex min-h-full flex-col">
      <p className="sr-only" role="status">
        {t("loading")}
      </p>
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-5 w-24" />
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
        <div className="flex items-center gap-4">
          <Skeleton className="h-16 w-16 shrink-0 rounded-2xl" />
          <div>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-8 w-40" />
          </div>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-52 w-full rounded-2xl" />
          ))}
        </div>
      </main>
    </div>
  );
}
