// Shared GitHub release plumbing for the gate's resolver and the baseline scan.
// Auth comes from GITHUB_TOKEN when set; private repos need a PAT with read
// access to the pinned repos (the gate uses secrets.GH_PAT).

const API = 'https://api.github.com';

export function ghHeaders(accept) {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// CI egress drops connections mid-transfer now and then (ECONNRESET); a 4xx is an
// answer, a socket error is not — retry only the latter, briefly.
export async function fetchWithRetry(url, opts, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (i >= attempts) throw err;
      console.error(`fetch ${url} failed (${err.cause?.code ?? err.message}), retry ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

export async function getRelease(repo, tag) {
  const url =
    tag === 'latest'
      ? `${API}/repos/${repo}/releases/latest`
      : `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetchWithRetry(url, { headers: ghHeaders('application/vnd.github+json') });
  if (res.status === 404) {
    // Fine-grained PATs answer 404 (not 403) for private repos they were never
    // granted — say so, or a correct pin reads like a missing release.
    throw new Error(
      `GET ${url} -> 404. Either the tag does not exist, or ${repo} is private and the token (GITHUB_TOKEN / secrets.GH_PAT) has no read access to it — grant the PAT that repo`
    );
  }
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/** Newest-first releases of a repo (one page — the scan only walks recent history). */
export async function listReleases(repo, perPage = 15) {
  const url = `${API}/repos/${repo}/releases?per_page=${perPage}`;
  const res = await fetchWithRetry(url, { headers: ghHeaders('application/vnd.github+json') });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

// The asset API endpoint + octet-stream, not browser_download_url: the latter 404s on
// private repos.
// The retry covers the BODY, not just the request: a runtime blob is megabytes
// and a reset part-way through throws from arrayBuffer(), outside fetchWithRetry.
export async function downloadAssetBytes(asset, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(asset.url, {
        headers: ghHeaders('application/octet-stream'),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`download ${asset.name} -> ${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i >= attempts) throw err;
      console.error(
        `download ${asset.name} failed (${err.cause?.code ?? err.message}), retry ${i}/${attempts - 1}`
      );
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}
