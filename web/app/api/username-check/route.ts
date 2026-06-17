import { NextResponse, type NextRequest } from "next/server";

import { validateUsername } from "@/lib/profile/username";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Advisory username availability check for the settings UI ("设置 UI 查仅提示").
 *
 * This is ONLY a hint — the DB unique index is the authority and a concurrent
 * claim can still lose at write time. Usernames are public (Organizer Profile
 * `/u/[username]`), so existence isn't sensitive; we still gate the endpoint to
 * signed-in hosts to limit casual enumeration. The trusted client is used for a
 * single boolean read across rows that RLS otherwise hides from the caller.
 */
export async function GET(request: NextRequest) {
  const candidate = request.nextUrl.searchParams.get("u") ?? "";

  // Must be a signed-in host.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ available: false, reason: "unauthorized" }, { status: 401 });
  }

  const parsed = validateUsername(candidate);
  if (!parsed.ok) {
    return NextResponse.json({ available: false, reason: parsed.error });
  }

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .eq("username", parsed.value)
    .neq("id", user.id) // your own current handle doesn't count as "taken"
    .maybeSingle();

  if (error) {
    return NextResponse.json({ available: null, reason: "check_failed" }, { status: 200 });
  }

  return NextResponse.json({ available: data === null, username: parsed.value });
}
