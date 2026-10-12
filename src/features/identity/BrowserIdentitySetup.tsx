import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import type { BrowserIdentity } from "./browser";
import { npubOf } from "./local-key";

function preview(nsec: string) {
  try {
    return nsec.trim() ? npubOf(nsec) : undefined;
  } catch {
    return undefined;
  }
}

/** Browser sign-in: a NIP-07 extension, or a NIP-49 key unlocked once per session. */
export function BrowserIdentitySetup({
  identity,
  children,
}: {
  identity: BrowserIdentity;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const [importing, setImporting] = useState(false);
  const [nsec, setNsec] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  if (state.status === "ready") return children;
  const busy = "busy" in state && state.busy;
  const npub = preview(nsec);
  return (
    <main className="p-8" aria-labelledby="identity-setup-title">
      <h1 id="identity-setup-title" className="text-heading">
        Your Buzz identity
      </h1>
      {state.status === "loading" ? (
        <p role="status">Connecting to your signer…</p>
      ) : state.status === "error" ? (
        <>
          <p role="alert">{state.error}</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void identity.retry()}>Retry</Button>
            <Button onClick={identity.forgetKey}>Use another method</Button>
          </div>
        </>
      ) : state.status === "locked" ? (
        <form
          className="flex max-w-md flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const supplied = passphrase;
            setPassphrase("");
            identity.unlock(supplied);
          }}
        >
          <p>Enter your passphrase to unlock the key saved in this browser.</p>
          {state.error && <p role="alert">{state.error}</p>}
          <label htmlFor="unlock-passphrase">Passphrase</label>
          <Input
            id="unlock-passphrase"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={passphrase}
            disabled={busy}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !passphrase}
            >
              Unlock
            </Button>
            <Button type="button" disabled={busy} onClick={identity.forgetKey}>
              Forget key on this device
            </Button>
          </div>
          {busy && <p role="status">Unlocking…</p>}
        </form>
      ) : importing ? (
        <form
          className="flex max-w-md flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const [key, secret] = [nsec, passphrase];
            setNsec("");
            setPassphrase("");
            setConfirm("");
            identity.saveKey(key, secret);
          }}
        >
          {state.error && <p role="alert">{state.error}</p>}
          <label htmlFor="import-nsec">Private key (nsec)</label>
          <Input
            id="import-nsec"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={nsec}
            disabled={busy}
            onChange={(event) => setNsec(event.target.value)}
          />
          <p>
            {npub
              ? `Identity: ${npub}`
              : "Copy this from Settings → Profile in Buzz desktop. Never share it."}
          </p>
          <label htmlFor="key-passphrase">
            Passphrase (at least 8 characters)
          </label>
          <Input
            id="key-passphrase"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            disabled={busy}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <label htmlFor="key-passphrase-confirm">Confirm passphrase</label>
          <Input
            id="key-passphrase-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            disabled={busy}
            onChange={(event) => setConfirm(event.target.value)}
          />
          <p>
            Buzz saves only an encrypted copy (NIP-49) in this browser. While
            unlocked, this page holds your key in memory.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy || !npub || passphrase.length < 8 || passphrase !== confirm
              }
            >
              Save and unlock
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setNsec("");
                setPassphrase("");
                setConfirm("");
                setImporting(false);
              }}
            >
              Back
            </Button>
          </div>
          {busy && <p role="status">Encrypting your key…</p>}
        </form>
      ) : (
        <>
          <p>How should Buzz sign for you in this browser?</p>
          {state.error && <p role="alert">{state.error}</p>}
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" onClick={() => setImporting(true)}>
              Use my key on this device
            </Button>
            <Button onClick={() => void identity.chooseExtension()}>
              Use a signer extension (NIP-07)
            </Button>
          </div>
          <p>
            With your key on this device you unlock once with a passphrase and
            are not asked to approve each signature.
          </p>
        </>
      )}
    </main>
  );
}
