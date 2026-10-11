// Serving the CLI tarball, so onboarding needs no file transfer.
//
// WHY. Until now an admin had to send each engineer two things privately: their
// `e8k_` key and a `tracker.tgz` downloaded from GitHub Releases. The tarball is
// the awkward half — engineers have no GitHub access to this org (that is the
// whole point of the tracker: the key grants repo access without a personal
// login), so they cannot fetch it themselves, and a file sent over chat goes
// stale the moment a new version ships.
//
// The key is the only thing that genuinely has to be sent, and the engineer
// already has it. So the server hands out the tarball to anyone holding a valid
// key, using credentials it already has: the GitHub App installation that covers
// this repository. Nothing new is stored and no second credential exists.

const USER_AGENT = "edge8-tracker-server";

/** owner/repo whose Releases hold the CLI tarball. */
export const releaseRepo = (): string =>
  process.env.CLI_RELEASE_REPO ?? "edge8-ai/edge8-github-app-tracker";

export interface Tarball {
  name: string;
  bytes: Uint8Array;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

/**
 * Download the newest release's `.tgz`, authenticated as the installation.
 *
 * Two GitHub calls, and the second has a trap: the asset endpoint answers with
 * a 302 to a signed object-store URL that rejects an `Authorization` header it
 * did not expect. So the redirect is followed by hand, WITHOUT the token —
 * following it automatically (fetch's default) sends the header on and fails.
 */
export async function fetchLatestTarball(
  token: string,
  repo = releaseRepo(),
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; tarball: Tarball } | { ok: false; status: number; error: string }> {
  const api = `https://api.github.com/repos/${repo}`;
  const auth = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
  };

  const relRes = await doFetch(`${api}/releases/latest`, { headers: auth });
  if (!relRes.ok) {
    // 404 here means the repo has no published release at all, which is a
    // deployment fact worth distinguishing from a credential problem.
    return {
      ok: false,
      status: relRes.status === 404 ? 503 : 502,
      error:
        relRes.status === 404
          ? "no published CLI release yet"
          : `github: releases/latest returned ${relRes.status}`,
    };
  }
  const release = await relRes.json();
  const asset = (release?.assets ?? []).find((a: any) =>
    String(a?.name ?? "").endsWith(".tgz"),
  );
  if (!asset?.url) {
    return { ok: false, status: 503, error: "latest release has no .tgz asset" };
  }

  const assetRes = await doFetch(asset.url, {
    headers: { ...auth, accept: "application/octet-stream" },
    redirect: "manual",
  });

  let bodyRes = assetRes;
  if (assetRes.status >= 300 && assetRes.status < 400) {
    const location = assetRes.headers?.get?.("location");
    if (!location) {
      return { ok: false, status: 502, error: "github: redirect without a location" };
    }
    // Deliberately unauthenticated: the location is already a signed URL.
    bodyRes = await doFetch(location, { headers: { "user-agent": USER_AGENT } });
  }
  if (!bodyRes.ok) {
    return { ok: false, status: 502, error: `github: asset returned ${bodyRes.status}` };
  }

  return {
    ok: true,
    tarball: {
      name: String(asset.name),
      bytes: new Uint8Array(await bodyRes.arrayBuffer()),
    },
  };
}
