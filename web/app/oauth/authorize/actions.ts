"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { checkAuthorizeRequest, clientRedirect, createAuthCode, decodeAuthorizeQuery, encodeAuthorizeQuery, publicOrigin } from "@/lib/oauth";
import { checkRateLimit } from "@/lib/rate-limit";

/** Decisión del usuario en la pantalla de consentimiento. Revalida TODO desde `q` (no confía en el formulario). */
export async function decideAction(formData: FormData): Promise<void> {
  const q = String(formData.get("q") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const origin = publicOrigin(await headers());
  const params = decodeAuthorizeQuery(q);
  const check = await checkAuthorizeRequest((k) => params.get(k), origin);
  if (!check.ok) {
    if (check.kind === "page") redirect(`/oauth/authorize?q=${encodeURIComponent(q)}`);
    redirect(clientRedirect(check.redirectUri, check.state, origin, { error: check.error, error_description: check.description }));
  }
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?q=${encodeAuthorizeQuery(params.toString())}`)}`);
  const { redirectUri, state } = check.params;
  if (decision !== "approve") redirect(clientRedirect(redirectUri, state, origin, { error: "access_denied" }));
  if (!checkRateLimit(`oauth-consent:${user.id}`, 20, 60_000)) {
    redirect(clientRedirect(redirectUri, state, origin, { error: "temporarily_unavailable" }));
  }
  const code = await createAuthCode(user.id, check.params, origin);
  redirect(clientRedirect(redirectUri, state, origin, { code }));
}
