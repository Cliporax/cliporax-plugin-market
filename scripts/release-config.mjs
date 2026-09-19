const releaseTagPattern = /^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/;
const defaultRepository = "Cliporax/cliporax-plugin-market";

export function resolveReleaseConfig(env, packageVersion) {
  const explicitTags = [env.RELEASE_TAG, env.CLIPORAX_MARKET_VERSION].filter(Boolean);
  if (new Set(explicitTags).size > 1) {
    throw new Error("RELEASE_TAG and CLIPORAX_MARKET_VERSION must identify the same release.");
  }

  const explicitBase = env.CLIPORAX_MARKET_RELEASE_BASE_URL?.replace(/\/+$/, "");
  let baseTag;
  if (explicitBase) {
    const url = new URL(explicitBase);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Release base URL must use HTTP or HTTPS.");
    }
    if (url.hostname === "github.com") {
      const match = url.pathname.match(/^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)$/);
      if (!match || url.search || url.hash) {
        throw new Error("GitHub release base URL must end with /releases/download/vX.Y.Z.");
      }
      baseTag = decodeURIComponent(match[1]);
    }
  }

  // GITHUB_REF_NAME is a branch name during manual runs from main.
  const tag = explicitTags[0]
    || (env.GITHUB_REF_TYPE === "tag" ? env.GITHUB_REF_NAME : undefined)
    || baseTag
    || `v${packageVersion}`;
  if (!releaseTagPattern.test(tag) || (baseTag && !releaseTagPattern.test(baseTag))) {
    throw new Error("Release tag must be a version such as v0.1.9; branch names are not release tags.");
  }
  if (baseTag && baseTag !== tag) {
    throw new Error(`Release URL tag ${baseTag} does not match market version ${tag}.`);
  }

  return {
    marketVersion: tag,
    baseUrl: explicitBase
      || `https://github.com/${env.GITHUB_REPOSITORY || defaultRepository}/releases/download/${tag}`,
  };
}
