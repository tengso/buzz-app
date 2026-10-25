import type { PluginModule } from "../../plugins/api";
import { ListChecksIcon } from "../../shared/design-system/icons";
import { keelSettings } from "./gateway";
import { KeelPage } from "./KeelPage";
import { KeelPanel } from "./KeelPanel";
import { KeelSettings } from "./KeelSettings";
import { parseKeelReference } from "./references";

/** Keel is the governed record (design 14 in tengso/keel): this plugin renders its tasks and
 * objects from the Gateway as the viewer, and turns a decision into a signed reply in the
 * task's thread, which Keel's follower verifies and applies. Nothing is written over HTTP. */
export const inject = [
  "panels",
  "pages",
  "relay",
  "navigation",
  "settingsCards",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  ctx.panels.register({
    id: "record",
    title: "Keel",
    matches: (target) => !!parseKeelReference(target, keelSettings().workbench),
    component: (props) => <KeelPanel relay={relay} {...props} />,
  });
  ctx.pages.register({
    id: "keel",
    title: "Keel",
    layout: "workspace",
    primary: true,
    component: () => <KeelPage relay={relay} navigator={navigator} />,
  });
  ctx.settingsCards.register({
    id: "keel",
    title: "Keel",
    icon: ListChecksIcon,
    component: () => <KeelSettings />,
  });
};
