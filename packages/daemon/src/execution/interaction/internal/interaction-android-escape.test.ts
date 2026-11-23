import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { makeAndroidSession } from '../../../__tests__/support/session-factories.ts';
import { detectAndroidEscapeSurface } from '../../android-foreground-surface.ts';
import { assertAndroidPressStayedInApp } from './interaction-android-escape.ts';

// #5034: a tap that starts another app's activity leaves the session app focused for a moment, so
// the guard re-reads the focus for a bounded time before it passes the tap.

const APP = 'com.example.app';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The session app owns the focus for the first `appFocusedReads` reads, then `foregroundAfter`. */
function observationWithFocusChange(appFocusedReads: number, foregroundAfter: string) {
  let reads = 0;
  const readAppFocus = vi.fn(async () => {
    reads += 1;
    return reads <= appFocusedReads;
  });
  const observation = {
    readAppFocus,
    readAppState: async () => ({ package: foregroundAfter, activity: 'Main' }),
    isPermissionPackage: async () => false,
  } as unknown as AndroidObservationAdapter;
  return { observation, readAppFocus };
}

function pressInApp(observation: AndroidObservationAdapter, focusedPackageBefore?: string) {
  return assertAndroidPressStayedInApp(
    makeAndroidSession('android-escape-focus-change', { appBundleId: APP }),
    { command: 'press', targetLabel: '@e1', focusedPackageBefore },
    observation,
  );
}

test('press fails when Settings takes the focus after the first read still named the app', async () => {
  const { observation } = observationWithFocusChange(2, 'com.android.settings');
  const press = pressInApp(observation);
  const settled = expect(press).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { expectedPackage: APP, foregroundPackage: 'com.android.settings' },
  });
  await vi.advanceTimersByTimeAsync(100);
  await settled;
});

test('press passes once the app has kept the focus for the whole wait', async () => {
  const { observation, readAppFocus } = observationWithFocusChange(
    Infinity,
    'com.android.settings',
  );
  let result: string | undefined | 'pending' = 'pending';
  void pressInApp(observation).then((value) => {
    result = value;
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(result).toBe('pending');
  await vi.advanceTimersByTimeAsync(50);
  expect(result).toBeUndefined();
  expect(readAppFocus.mock.calls.length).toBeGreaterThan(1);
});

test('press reads the focus once when another package already owns it', async () => {
  const { observation, readAppFocus } = observationWithFocusChange(0, 'com.android.chrome');
  await expect(pressInApp(observation)).resolves.toBeUndefined();
  expect(readAppFocus).toHaveBeenCalledTimes(1);
});

test('press does not read the focus when the launcher owned it before the dispatch', async () => {
  const { observation, readAppFocus } = observationWithFocusChange(
    Infinity,
    'com.google.android.apps.nexuslauncher',
  );
  await expect(
    pressInApp(observation, 'com.google.android.apps.nexuslauncher'),
  ).resolves.toBeUndefined();
  expect(readAppFocus).not.toHaveBeenCalled();
});

test('press does not read the focus on a provider-leased device', async () => {
  const { observation, readAppFocus } = observationWithFocusChange(Infinity, APP);
  const session = makeAndroidSession('android-escape-leased', {
    appBundleId: APP,
    lease: { leaseId: 'lease', tenantId: 'tenant', runId: 'run', leaseProvider: 'provider' },
  });
  await expect(
    assertAndroidPressStayedInApp(session, { command: 'press', targetLabel: '@e1' }, observation),
  ).resolves.toBeUndefined();
  expect(readAppFocus).not.toHaveBeenCalled();
});

test('a foreground check outside the press guard reads the focus once', async () => {
  const { observation, readAppFocus } = observationWithFocusChange(1, 'com.android.settings');
  await expect(
    detectAndroidEscapeSurface(
      makeAndroidSession('android-escape-focus-once', { appBundleId: APP }),
      observation,
    ),
  ).resolves.toBeNull();
  expect(readAppFocus).toHaveBeenCalledTimes(1);
});
