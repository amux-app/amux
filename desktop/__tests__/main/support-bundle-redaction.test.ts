import { describe, expect, it } from 'vitest';
import { buildPathTokenizer, redactSecrets, stripAnsi } from '../../src/main/services/supportBundleRedaction';

// Assembled at runtime so no credential-shaped literal is committed and trips scripts/internal-refs-gate.mjs.
const quotedAssignment = (key: string, value: string): string => `${key}="${value}"`;

describe('buildPathTokenizer', () => {
  it('tokenizes worktree, project, and home with longest-prefix-first ordering', () => {
    // Arrange
    const tokenize = buildPathTokenizer({
      homeDir: '/Users/alice',
      projectRoot: '/Users/alice/proj',
      worktrees: [{ slug: 'feat-x', path: '/Users/alice/proj/.worktrees/feat-x' }],
    });
    const input = 'wt=/Users/alice/proj/.worktrees/feat-x root=/Users/alice/proj home=/Users/alice';

    // Act
    const output = tokenize(input);

    // Assert
    expect(output).toBe('wt=<WORKTREE:feat-x> root=<PROJECT> home=<HOME>');
    expect(output).not.toContain('/Users/alice');
  });

  it('does not let a shorter prefix eat a longer worktree path', () => {
    // Arrange
    const tokenize = buildPathTokenizer({
      homeDir: '/Users/alice',
      projectRoot: '/Users/alice/proj',
      worktrees: [{ slug: 'feat-x', path: '/Users/alice/proj/.worktrees/feat-x' }],
    });

    // Act
    const output = tokenize('/Users/alice/proj/.worktrees/feat-x/src/index.ts');

    // Assert
    expect(output).toBe('<WORKTREE:feat-x>/src/index.ts');
  });

  it('only replaces a path at a boundary and does not eat a longer sibling name', () => {
    // Arrange
    const tokenize = buildPathTokenizer({ homeDir: '/Users/bob', projectRoot: '', worktrees: [] });

    // Act
    const bobby = tokenize('/Users/bobby/x');
    const exact = tokenize('/Users/bob');
    const nested = tokenize('/Users/bob/proj');
    const quoted = tokenize('"/Users/bob"');

    // Assert
    expect(bobby).toBe('/Users/bobby/x');
    expect(exact).toBe('<HOME>');
    expect(nested).toBe('<HOME>/proj');
    expect(quoted).toBe('"<HOME>"');
  });

  it('skips a root-ish or empty path instead of eating every slash', () => {
    // Arrange
    const tokenize = buildPathTokenizer({ homeDir: '/', projectRoot: '', worktrees: [{ slug: 'x', path: '/' }] });

    // Act
    const output = tokenize('/Users/bob/proj/file.ts');

    // Assert
    expect(output).toBe('/Users/bob/proj/file.ts');
  });
});

describe('redactSecrets', () => {
  it('redacts known credential kinds and counts hits', () => {
    // Arrange
    const input = [
      'openai sk-ABCDEFGHIJKLMNOP1234',
      'github ghp_0123456789ABCDEFGHIJ0123456789ABCD',
      'aws AKIAIOSFODNN7EXAMPLE',
      'Authorization: Bearer abc.def.ghi',
      'url https://user:secret@example.com/path',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('<REDACTED:openai-key>');
    expect(text).toContain('<REDACTED:github-token>');
    expect(text).toContain('<REDACTED:aws-access-key-id>');
    expect(text).toContain('Authorization: Bearer <REDACTED:authorization-bearer>');
    expect(text).toContain('https://<REDACTED:url-credentials>@example.com/path');
    expect(text).not.toContain('sk-ABCDEFGHIJKLMNOP1234');
    expect(text).not.toContain('secret@example.com');
    expect(hits['openai-key']).toBe(1);
    expect(hits['github-token']).toBe(1);
    expect(hits['aws-access-key-id']).toBe(1);
    expect(hits['authorization-bearer']).toBe(1);
    expect(hits['url-credentials']).toBe(1);
  });

  it('redacts a multiline private-key block as a whole', () => {
    // Arrange
    const input = [
      'key:',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAabc123def456',
      'ghi789jkl012mno345pqr678',
      '-----END RSA PRIVATE KEY-----',
      'done',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('<REDACTED:private-key>');
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(text).not.toContain('MIIEpAIBAAKCAQEA');
    expect(text).toContain('key:');
    expect(text).toContain('done');
    expect(hits['private-key']).toBe(1);
  });

  it('redacts a PKCS#8 encrypted private key with a non-RSA header', () => {
    // Arrange
    const input = [
      'before',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      'MIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG',
      '-----END ENCRYPTED PRIVATE KEY-----',
      'after',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('<REDACTED:private-key>');
    expect(text).not.toContain('BEGIN ENCRYPTED PRIVATE KEY');
    expect(text).not.toContain('MIIFHDBOBgkqhkiG9w0BBQ0');
    expect(text).toContain('before');
    expect(text).toContain('after');
    expect(hits['private-key']).toBe(1);
  });

  it('redacts a bare PRIVATE KEY block with no qualifier', () => {
    // Arrange
    const input = ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEF', '-----END PRIVATE KEY-----'].join('\n');

    // Act
    const { text } = redactSecrets(input);

    // Assert
    expect(text).toBe('<REDACTED:private-key>');
  });

  it('redacts an SSH2 (4-dash) private key block', () => {
    // Arrange
    const input = [
      '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----',
      'Comment: "rsa-key"',
      'P2/56wAAAg4AAAA',
      '---- END SSH2 ENCRYPTED PRIVATE KEY ----',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('<REDACTED:private-key>');
    expect(text).not.toContain('P2/56wAAAg4AAAA');
    expect(hits['private-key']).toBe(1);
  });

  it('redacts a PuTTY private key block through its Private-MAC line', () => {
    // Arrange
    const input = [
      'PuTTY-User-Key-File-2: ssh-rsa',
      'Encryption: none',
      'Comment: imported-key',
      'Public-Lines: 4',
      'AAAAB3NzaC1yc2EAAAAB',
      'Private-Lines: 8',
      'AAABAQCsecretkeymaterial',
      'Private-MAC: 0123456789abcdef0123456789abcdef01234567',
      'trailing log line',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('<REDACTED:private-key>');
    expect(text).not.toContain('AAABAQCsecretkeymaterial');
    expect(text).not.toContain('Private-MAC:');
    expect(text).toContain('trailing log line');
    expect(hits['private-key']).toBe(1);
  });

  it('redacts an AWS secret access key by assignment and as a bounded standalone token', () => {
    // Arrange
    const input = [
      'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'leaked wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEK2Y here',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('aws_secret_access_key = <REDACTED:aws-secret-access-key>');
    expect(text).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(text).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEK2Y');
    expect(hits['aws-secret-access-key']).toBe(2);
  });

  it('redacts non-standard secret key-names while preserving the key', () => {
    // Arrange
    const input = [
      'DB_PASS: hunter2secret',
      'x-api-token=abcdefghij123456',
      'CLIENT_SECRET: superSecretValue',
      'connection_string="Server=db;Password=pw123456"',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('DB_PASS: <REDACTED:secret-assignment>');
    expect(text).toContain('x-api-token=<REDACTED:secret-assignment>');
    expect(text).toContain('CLIENT_SECRET: <REDACTED:secret-assignment>');
    expect(text).not.toContain('hunter2secret');
    expect(text).not.toContain('superSecretValue');
    expect(hits['secret-assignment']).toBeGreaterThanOrEqual(3);
  });

  it('does not mangle benign boolean assignments or normal git hashes', () => {
    // Arrange
    const input = [
      'auth: true',
      'enabled: false',
      'session=on',
      'commit da39a3ee5e6b4b0d3255bfef95601890afd80709 landed',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toBe(input);
    expect(Object.keys(hits)).toHaveLength(0);
  });

  it('redacts a JWT', () => {
    // Arrange
    const input = 'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('<REDACTED:jwt>');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(hits['jwt']).toBe(1);
  });

  it('redacts secret-named assignments while keeping the key name', () => {
    // Arrange
    const input = [
      'PASSWORD=hunter2longenough',
      quotedAssignment('export API_KEY', 's3cr3tValueNotAVendorToken'),
      'client_secret: "abcd1234efgh5678"',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('PASSWORD=<REDACTED:secret-assignment>');
    expect(text).toContain('API_KEY="<REDACTED:secret-assignment>"');
    expect(text).toContain('client_secret: "<REDACTED:secret-assignment>"');
    expect(text).not.toContain('hunter2longenough');
    expect(text).not.toContain('abcd1234efgh5678');
    expect(hits['secret-assignment']).toBe(3);
  });

  it('redacts provider-specific keys', () => {
    // Arrange
    const input = [
      'google AIzaSyA1234567890abcdefghijklmnopqrstuvw',
      'stripe sk_live_0123456789abcdefABCDEF',
      'gitlab glpat-abcdefghij0123456789',
      'anthropic sk-ant-api03-abcdefghij0123456789',
      'hf hf_abcdefghijklmnopqrstuvwxyz01234567',
    ].join('\n');

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('<REDACTED:google-api-key>');
    expect(text).toContain('<REDACTED:stripe-key>');
    expect(text).toContain('<REDACTED:gitlab-token>');
    expect(text).toContain('<REDACTED:anthropic-key>');
    expect(text).toContain('<REDACTED:huggingface-token>');
    expect(text).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstuvw');
    expect(text).not.toContain('sk_live_0123456789abcdefABCDEF');
    expect(hits['google-api-key']).toBe(1);
    expect(hits['stripe-key']).toBe(1);
    expect(hits['gitlab-token']).toBe(1);
    expect(hits['anthropic-key']).toBe(1);
    expect(hits['huggingface-token']).toBe(1);
  });

  it('strips credentials from non-http database URLs', () => {
    // Arrange
    const input = 'db postgres://user:s3cretpw@db.example.com:5432/app';

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toContain('postgres://<REDACTED:url-credentials>@db.example.com:5432/app');
    expect(text).not.toContain('s3cretpw');
    expect(hits['url-credentials']).toBe(1);
  });

  it('catches a github token even when an ANSI reset splits it after stripping', () => {
    // Arrange
    const raw = 'ghp_0123456789\x1b[0mABCDEFGHIJ0123456789ABCD';

    // Act
    const { text, hits } = redactSecrets(stripAnsi(raw));

    // Assert
    expect(text).toContain('<REDACTED:github-token>');
    expect(text).not.toContain('ghp_0123456789');
    expect(hits['github-token']).toBe(1);
  });

  it('leaves plain text untouched with no hits', () => {
    // Arrange
    const input = 'The agent created a pane and merged the worktree successfully. Password reset link sent.';

    // Act
    const { text, hits } = redactSecrets(input);

    // Assert
    expect(text).toBe(input);
    expect(Object.keys(hits)).toHaveLength(0);
  });
});
