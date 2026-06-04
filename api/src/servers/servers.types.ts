export type KeyAuth = {
  type: 'key';
  privateKey: string;
  passphrase?: string;
};

export type PasswordAuth = {
  type: 'password';
  password: string;
};

export type ServerAuth = KeyAuth | PasswordAuth;

export type ServerConfig = {
  id: string;          // "<groupId>/<serverId>"
  groupId: string;
  serverId: string;
  name: string;        // display label
  host: string;
  port: number;
  user: string;
  auth: ServerAuth;
  aiContext?: string;  // free-text note describing the box, fed to the AI chat system prompt
};

export type ServerSummary = {
  id: string;
  groupId: string;
  serverId: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authType: ServerAuth['type'];
};

export type GroupSummary = {
  id: string;
  name: string;
  description?: string;
  servers: ServerSummary[];
};

export type ServerDetail = ServerSummary & {
  groupName: string;
  groupDescription?: string;
  keyPath?: string;          // resolved (after ~/$ENV expansion)
  rawKeyPath?: string;       // as written in YAML
  passphraseSet: boolean;
  passwordSet: boolean;
};
