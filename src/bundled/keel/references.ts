/** What a Keel reference points at: a task or an object of the governed record. */
export type KeelReference =
  | Readonly<{ kind: "task"; id: string; url: string }>
  | Readonly<{ kind: "object"; type: string; pk: string; url: string }>;

const TASK = /^task-[0-9a-f]{10}$/;
const TYPE = /^[a-z][a-z0-9_]*\.[A-Z][A-Za-z0-9]*$/;

/** `keel://task/<id>` and `keel://<type>/<pk>` as Keel posts them, plus the workbench's
 * `/t/<id>` and `/o/<type>/<pk>` routes under the configured workbench origin. */
export function parseKeelReference(
  value: string,
  workbenchOrigin = "",
): KeelReference | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password) return;
    let parts: string[];
    if (url.protocol === "keel:") {
      parts = [url.hostname, ...url.pathname.split("/")].filter(Boolean);
    } else if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      workbenchOrigin &&
      url.origin === new URL(workbenchOrigin).origin
    ) {
      const route = url.pathname.split("/").filter(Boolean);
      if (route[0] === "t") parts = ["task", ...route.slice(1)];
      else if (route[0] === "o") parts = route.slice(1);
      else return;
    } else return;
    const [head, ...rest] = parts.map((part) => decodeURIComponent(part));
    if (head === "task" && rest.length === 1 && TASK.test(rest[0] ?? ""))
      return { kind: "task", id: rest[0] ?? "", url: `keel://task/${rest[0]}` };
    if (head && TYPE.test(head) && rest.length >= 1) {
      const pk = rest.join("/");
      return {
        kind: "object",
        type: head,
        pk,
        url: `keel://${head}/${encodeURIComponent(pk)}`,
      };
    }
  } catch {
    /* Authored prose is not necessarily a URL. */
  }
}
