import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { Deadline, sleep } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { isActiveProviderDevice } from '../core/provider-device-admission.ts';
import type { SessionState } from '../core/session-state.ts';

export type AndroidEscapeSurface = {
  expectedPackage: string;
  foregroundPackage: string;
  activity?: string;
  hint: string;
  permissionDialog?: boolean;
};

const FOCUS_CHANGE_POLL_MS = 50;

/**
 * With `focusChangeWaitMs`, a read that finds the session app still focused is repeated until
 * another package owns the focus or the wait runs out, so a focus change already under way when
 * the read starts is seen.
 */
export async function detectAndroidEscapeSurface(
  session: SessionState,
  observation?: AndroidObservationAdapter,
  options: Readonly<{ focusChangeWaitMs?: number }> = {},
): Promise<AndroidEscapeSurface | null> {
  if (
    session.device.platform !== 'android' ||
    !session.appBundleId ||
    session.lease?.leaseProvider ||
    isActiveProviderDevice(session.device)
  ) {
    return null;
  }

  if (!observation) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Android observation was not supplied by root runtime composition',
    );
  }

  if (
    await sessionAppKeepsFocus(
      observation,
      session.device,
      session.appBundleId,
      options.focusChangeWaitMs ?? 0,
    )
  ) {
    return null;
  }
  const foreground = await observation.readAppState(session.device);
  const foregroundPackage = foreground.package?.trim();
  if (!foregroundPackage || foregroundPackage === session.appBundleId) return null;
  const permissionDialog = await observation.isPermissionPackage(foregroundPackage);
  if (!looksLikeAndroidEscapeSurface(foregroundPackage) && !permissionDialog) return null;

  return {
    expectedPackage: session.appBundleId,
    foregroundPackage,
    activity: foreground.activity,
    hint: buildAndroidEscapeHint(permissionDialog),
    ...(permissionDialog ? { permissionDialog: true } : {}),
  };
}

async function sessionAppKeepsFocus(
  observation: AndroidObservationAdapter,
  device: SessionState['device'],
  appBundleId: string,
  waitMs: number,
): Promise<boolean> {
  const deadline = Deadline.fromTimeoutMs(waitMs);
  while (await observation.readAppFocus(device, appBundleId)) {
    if (deadline.isExpired()) return true;
    await sleep(Math.min(FOCUS_CHANGE_POLL_MS, deadline.remainingMs()));
  }
  return false;
}

export function describeAndroidEscapeSurface(surface: AndroidEscapeSurface): string {
  if (surface.permissionDialog) {
    return `Android permission dialog is blocking ${surface.expectedPackage}`;
  }
  return `${surface.foregroundPackage} is foreground instead of ${surface.expectedPackage}`;
}

function buildAndroidEscapeHint(permissionDialog: boolean): string {
  if (permissionDialog) {
    return 'Use "alert get" to inspect it, then "alert accept" or "alert dismiss" to respond.';
  }
  return 'Use screenshot as visual truth, then take a fresh snapshot -i before retrying.';
}

export function looksLikeAndroidEscapeSurface(packageName: string): boolean {
  return (
    packageName === 'com.android.settings' ||
    packageName === 'com.android.systemui' ||
    packageName.includes('launcher')
  );
}
