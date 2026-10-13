import type { PluginModule } from "../../plugins/api";
import { browserHostEnabled } from "../../features/identity/browser";
import { MissionControlPage } from "./MissionControlPage";

/** Web builds made with BUZZ_MISSION_CONTROL=1 (see docs/browser-host.md). */
export const missionControlEnabled = () =>
  browserHostEnabled() && import.meta.env.VITE_BUZZ_MISSION_CONTROL === "1";

export const inject = ["pages"];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!missionControlEnabled()) return;
  ctx.pages.register({
    id: "mission-control",
    title: "Mission Control",
    layout: "workspace",
    primary: true,
    component: () => <MissionControlPage />,
  });
};
