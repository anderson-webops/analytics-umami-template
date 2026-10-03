import { produce } from 'immer';
import semver from 'semver';
import { create } from 'zustand';
import { CURRENT_VERSION, REPO_URL, UPDATES_URL, VERSION_CHECK } from '@/lib/constants';
import { getItem } from '@/lib/storage';

function getReleaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const url = new URL(value);
    const repository = new URL(REPO_URL);
    const tagPath = `${repository.pathname}/releases/tag/`;
    const tag = url.pathname.startsWith(tagPath) ? url.pathname.slice(tagPath.length) : null;
    const isRelease =
      url.pathname === `${repository.pathname}/releases/latest` ||
      (tag !== null && semver.valid(tag) !== null);

    return url.origin === repository.origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      isRelease
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const initialState = {
  current: CURRENT_VERSION,
  latest: null,
  hasUpdate: false,
  checked: false,
  releaseUrl: null,
};

const store = create(() => ({ ...initialState }));

export async function checkVersion() {
  const { current } = store.getState();

  const data = await fetch(`${UPDATES_URL}?v=${current}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  }).then(res => {
    if (res.ok) {
      return res.json();
    }

    return null;
  });

  if (!data) {
    return;
  }

  store.setState(
    produce(state => {
      const latest =
        typeof data.latest === 'string' && semver.valid(data.latest) ? data.latest : null;
      const lastCheck = getItem(VERSION_CHECK);

      const hasUpdate = !!(latest && lastCheck?.version !== latest && semver.gt(latest, current));

      state.current = current;
      state.latest = latest;
      state.hasUpdate = hasUpdate;
      state.checked = true;
      state.releaseUrl = getReleaseUrl(data.url);

      return state;
    }),
  );
}

export const useVersion = store;
