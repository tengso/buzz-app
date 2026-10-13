import { useState, useSyncExternalStore } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Field } from "../../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { type AppLink, MAX_LINKS, newLinkId, validLink } from "./model";
import type { AppLinks } from "./store";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export function AppLinksSettings({
  links,
}: {
  links: AppLinks;
  active(): boolean;
}) {
  const snapshot = useSyncExternalStore(
    links.subscribe,
    links.snapshot,
    links.snapshot,
  );
  return (
    <section aria-labelledby="app-links-settings-title" className="grid gap-6">
      <Header
        id="app-links-settings-title"
        title="Apps"
        subtitle={`Web apps on ${location.host}, each opened as a page in the sidebar.`}
      />
      {snapshot.status === "offline" && (
        <p className="text-body-sm text-muted">
          Connect to the community to see and manage apps.
        </p>
      )}
      {snapshot.status === "loading" && (
        <p className="text-body-sm text-muted" role="status">
          Loading apps…
        </p>
      )}
      {snapshot.error && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="error">
            {snapshot.error}
          </p>
          <Button size="compact" onClick={links.refresh}>
            Retry
          </Button>
        </div>
      )}
      {snapshot.status === "ready" && (
        <>
          <LinkList
            title="Community apps"
            description={
              snapshot.owner
                ? "Everyone in this community sees these."
                : "Chosen by the community owner for everyone."
            }
            links={snapshot.community}
            editable={snapshot.owner}
            save={(next) => links.save("community", next)}
          />
          <LinkList
            title="My apps"
            description={
              snapshot.personalAvailable
                ? "Only you see these. They are encrypted to your key and follow you to other browsers."
                : "Needs your key on this device, or a signer extension with NIP-44."
            }
            links={snapshot.personal}
            editable={snapshot.personalAvailable}
            save={(next) => links.save("personal", next)}
          />
        </>
      )}
    </section>
  );
}

function LinkList({
  title,
  description,
  links,
  editable,
  save,
}: {
  title: string;
  description: string;
  links: readonly AppLink[];
  editable: boolean;
  save(links: readonly AppLink[]): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [trusted, setTrusted] = useState(false);
  const run = async (next: readonly AppLink[]) => {
    setBusy(true);
    setError("");
    try {
      await save(next);
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const move = (index: number, offset: number) => {
    const next = [...links];
    const [item] = next.splice(index, 1);
    if (item) next.splice(index + offset, 0, item);
    void run(next);
  };
  const add = async () => {
    let link: AppLink;
    try {
      link = validLink({ id: newLinkId(), title: name, url: address, trusted });
    } catch (reason) {
      setError(message(reason));
      return;
    }
    if (await run([...links, link])) {
      setName("");
      setAddress("");
      setTrusted(false);
    }
  };
  return (
    <div className="grid gap-3">
      <InlineHeader title={title} subtitle={description} />
      {links.length === 0 ? (
        <p className="text-body-sm text-muted">No apps yet.</p>
      ) : (
        <ul aria-label={title} className="grid gap-2">
          {links.map((link, index) => (
            <li key={link.id} className="flex flex-wrap items-center gap-3">
              <div className="grid min-w-0 flex-1">
                <span className="truncate text-body">{link.title}</span>
                <span className="truncate text-body-sm text-muted">
                  {link.url}
                </span>
              </div>
              {editable ? (
                <>
                  <Checkbox
                    label="Trusted"
                    checked={link.trusted}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      void run(
                        links.map((item) =>
                          item.id === link.id
                            ? { ...item, trusted: checked === true }
                            : item,
                        ),
                      )
                    }
                  />
                  <IconButton
                    aria-label={`Move ${link.title} up`}
                    size="sm"
                    disabled={busy || index === 0}
                    icon={<ArrowUpIcon size={16} aria-hidden="true" />}
                    onClick={() => move(index, -1)}
                  />
                  <IconButton
                    aria-label={`Move ${link.title} down`}
                    size="sm"
                    disabled={busy || index === links.length - 1}
                    icon={<ArrowDownIcon size={16} aria-hidden="true" />}
                    onClick={() => move(index, 1)}
                  />
                  <IconButton
                    aria-label={`Remove ${link.title}`}
                    size="sm"
                    disabled={busy}
                    icon={<TrashIcon size={16} aria-hidden="true" />}
                    onClick={() =>
                      void run(links.filter((item) => item.id !== link.id))
                    }
                  />
                </>
              ) : (
                link.trusted && (
                  <span className="text-body-sm text-muted">Trusted</span>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && links.length < MAX_LINKS && (
        <form
          aria-label={`Add to ${title}`}
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <SettingsGroup layout="form">
            <Field label="Name">
              <Input
                value={name}
                maxLength={40}
                disabled={busy}
                placeholder="Research Admin"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field
              label="Address"
              description={`A path on ${location.host}, such as /HaiChat/my_app/, or a full address on this site.`}
            >
              <Input
                value={address}
                disabled={busy}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="/HaiChat/my_app/"
                onChange={(event) => setAddress(event.target.value)}
              />
            </Field>
            <Checkbox
              label="Trusted: let the app use this site's login and storage. Only for apps you fully trust: their scripts could read your unlocked key."
              checked={trusted}
              disabled={busy}
              onCheckedChange={(checked) => setTrusted(checked === true)}
            />
            <div>
              <Button
                type="submit"
                variant="prominent"
                disabled={busy || !name.trim() || !address.trim()}
                loading={busy}
              >
                Add app
              </Button>
            </div>
          </SettingsGroup>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
