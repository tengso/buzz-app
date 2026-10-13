import { useState } from "react";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
} from "../../shared/design-system/icons";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import type { AppLink } from "./model";

/** Untrusted apps get an opaque origin: no access to this page's storage or key. */
export const APP_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";

export function AppLinkPage({ link }: { link: AppLink }) {
  const [generation, setGeneration] = useState(0);
  const src = new URL(link.url, location.origin).href;
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label={link.title}>
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title={link.title}
            actions={
              <>
                <IconButton
                  aria-label={`Open ${link.title} in a new tab`}
                  size="sm"
                  icon={<ArrowSquareOutIcon size={16} aria-hidden="true" />}
                  onClick={() => window.open(src, "_blank", "noopener")}
                />
                <IconButton
                  aria-label={`Reload ${link.title}`}
                  size="sm"
                  icon={<ArrowClockwiseIcon size={16} aria-hidden="true" />}
                  onClick={() => setGeneration((value) => value + 1)}
                />
              </>
            }
          />
          <iframe
            key={generation}
            title={link.title}
            src={src}
            {...(link.trusted ? {} : { sandbox: APP_SANDBOX })}
            className="min-h-0 w-full flex-1 border-0"
          />
        </div>
      </FullPageSurface>
    </div>
  );
}
