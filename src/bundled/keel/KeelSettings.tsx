import { useState, useSyncExternalStore } from "react";
import {
  browserHostEnabled,
  browserSignEvent,
} from "../../features/identity/browser";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Header } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import {
  defaultSettings,
  keelFetch,
  keelSettings,
  saveKeelSettings,
  subscribeKeelSettings,
  type KeelSettings as Settings,
} from "./gateway";
import { forgetKeelConversation } from "./KeelPanel";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** Where Keel's Gateway is and, for hosts that cannot sign, a token; checked by reading the inbox. */
export function KeelSettings() {
  const saved = useSyncExternalStore(
    subscribeKeelSettings,
    keelSettings,
    keelSettings,
  );
  const [draft, setDraft] = useState<Settings>(saved);
  const [result, setResult] = useState<string>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const check = async () => {
    setResult("Checking…");
    try {
      const { items } = await keelFetch<{ items: unknown[] }>(
        "/api/v1/tasks?state=open",
        {
          settings: draft,
          sign: browserHostEnabled() ? browserSignEvent : undefined,
          signal: AbortSignal.timeout(10_000),
        },
      );
      setResult(
        `Connected as you: ${items.length} open task${items.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setResult(message(error));
    }
  };
  return (
    <section aria-labelledby="keel-settings-title" className="grid gap-6">
      <Header
        id="keel-settings-title"
        title="Keel"
        subtitle="Keel holds the record. Reads go to its Gateway as you; decisions are replies you sign in the chat."
      />
      <SettingsGroup layout="form">
        <Field
          label="Gateway URL"
          description="Same-origin /keel by default, so the web host's Content-Security-Policy allows it."
        >
          <Input
            value={draft.gateway}
            onChange={(event) =>
              setDraft({ ...draft, gateway: event.target.value })
            }
            placeholder={defaultSettings().gateway}
          />
        </Field>
        <Field
          label="Workbench URL"
          description="Optional. Its /t/<task> and /o/<type>/<pk> links then open here."
        >
          <Input
            value={draft.workbench}
            onChange={(event) =>
              setDraft({ ...draft, workbench: event.target.value })
            }
            placeholder="https://keel.example/workbench"
          />
        </Field>
        <Field
          label="Keel token"
          description={
            browserHostEnabled()
              ? "Not needed here: this host signs reads with your key (NIP-98). Set one only to act as a service account."
              : "This host cannot sign reads; paste a token from `osym token create`."
          }
        >
          <Input
            type="password"
            value={draft.token}
            onChange={(event) =>
              setDraft({ ...draft, token: event.target.value })
            }
            autoComplete="off"
          />
        </Field>
      </SettingsGroup>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="compact"
          disabled={!dirty}
          onClick={() => {
            saveKeelSettings(draft);
            forgetKeelConversation();
          }}
        >
          Save
        </Button>
        <Button size="compact" onClick={() => void check()}>
          Check connection
        </Button>
        {result && (
          <p role="status" className="text-body-sm text-muted">
            {result}
          </p>
        )}
      </div>
    </section>
  );
}
