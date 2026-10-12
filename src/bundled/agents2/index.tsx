import type { PluginModule } from "../../plugins/api";
import { browserHostEnabled } from "../../features/identity/browser";
import { Agents2Page } from "./Agents2Page";

export const inject = ["pages", "agents2", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents2, relay } = ctx;
  // Agents2 needs native key custody; the browser host has none.
  if (browserHostEnabled()) return;
  ctx.pages.register({
    id: "agents2",
    title: "Agents2",
    layout: "workspace",
    primary: true,
    component: () => <Agents2Page agents2={agents2} relay={relay} />,
  });
};
