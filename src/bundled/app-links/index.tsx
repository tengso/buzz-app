import type { Context } from "@deepseek-ai/cordis";
import type { PluginModule } from "../../plugins/api";
import { browserHostEnabled } from "../../features/identity/browser";
import { LinkIcon } from "../../shared/design-system/icons";
import { AppLinkPage } from "./AppLinkPage";
import { AppLinksSettings } from "./AppLinksSettings";
import { createAppLinks, type AppLinks } from "./store";

/** One primary page per link: the community's apps, then the viewer's own. */
export function showAppPages(ctx: Context, links: AppLinks) {
  let shown = "";
  let fiber: ReturnType<Context["plugin"]> | undefined;
  // Page keys are unique: retire the previous set before registering the next.
  let queue = Promise.resolve();
  const show = () => {
    const { community, personal } = links.snapshot();
    const entries = [
      ...community.map((link) => ({ page: `app-c-${link.id}`, link })),
      ...personal.map((link) => ({ page: `app-p-${link.id}`, link })),
    ];
    const signature = JSON.stringify(entries);
    if (signature === shown) return;
    shown = signature;
    queue = queue.then(async () => {
      await fiber?.dispose();
      fiber = undefined;
      if (!entries.length) return;
      fiber = ctx.plugin((scope: Context) => {
        for (const { page, link } of entries)
          scope.pages.register({
            id: page,
            title: link.title,
            layout: "workspace",
            primary: true,
            component: () => <AppLinkPage link={link} />,
          });
      });
    });
  };
  ctx.effect(() => links.subscribe(show));
  show();
}

export const inject = ["pages", "relay", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Lists live on the relay and pages frame same-origin apps: web builds only.
  if (!browserHostEnabled()) return;
  const links = createAppLinks(ctx.relay);
  ctx.effect(() => () => links.dispose());
  showAppPages(ctx, links);
  ctx.settingsCards.register({
    id: "apps",
    title: "Apps",
    icon: LinkIcon,
    component: ({ active }) => (
      <AppLinksSettings links={links} active={active} />
    ),
  });
};
