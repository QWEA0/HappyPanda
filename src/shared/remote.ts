export interface RemoteOwner {
  id: string;
  name: string;
}

export interface RemoteDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string;
  connected: boolean;
}

export interface RemotePairing {
  code: string;
  token: string;
  expiresAt: string;
}

export interface RemoteControlState {
  enabled: boolean;
  port?: number;
  addresses: string[];
  pairing?: RemotePairing;
  devices: RemoteDevice[];
  owner: RemoteOwner;
  error?: string;
}

export interface DesktopRemoteControlAPI {
  getState(): Promise<RemoteControlState>;
  setEnabled(enabled: boolean): Promise<RemoteControlState>;
  createPairing(): Promise<RemoteControlState>;
  revokeDevice(id: string): Promise<RemoteControlState>;
  takeControl(): Promise<RemoteControlState>;
  onState(callback: (state: RemoteControlState) => void): () => void;
}

export interface RemoteClientStatus {
  phase: 'unpaired' | 'connecting' | 'connected' | 'reconnecting' | 'revoked';
  authenticated: boolean;
  deviceId?: string;
  deviceName?: string;
  owner: RemoteOwner;
  message?: string;
}

export interface RemoteSessionInfo {
  deviceId: string;
  deviceName: string;
  owner: RemoteOwner;
}

export interface RemoteTerminalContext {
  nodeId: string;
  sessionId: string;
  generation?: number;
}

export const DESKTOP_OWNER: RemoteOwner = { id: 'desktop', name: 'PC' };

export const REMOTE_RPC_READ_METHODS = ['getState', 'listSshAliases', 'listLocalHistory'] as const;
export const REMOTE_RPC_WRITE_METHODS = [
  'saveNode', 'removeNode', 'saveProvider', 'removeProvider', 'selectProvider',
  'connect', 'disconnect', 'reconnect', 'focusSession', 'closeSession', 'newSession', 'removeSession', 'setLocalAccess', 'setWorkspaceMode',
  'syncNow', 'pauseSync', 'resolveConflict', 'importHistory', 'resumeImported',
  'importProjectMemory', 'addPortForward', 'removePortForward', 'pasteImage',
] as const;
