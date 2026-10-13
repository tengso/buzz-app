import { useEffect, useRef, useState } from "react";
import { browserSignEvent } from "../../features/identity/browser";
import {
  ArrowClockwiseIcon,
  ShieldIcon,
} from "../../shared/design-system/icons";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { answerSignRequests, missionControlUrl } from "./signing";

/** team-builder's Mission Control in a same-origin frame. The dashboard asks this
 * page to sign its owner challenges, so the owner signs in with their Buzz key. */
export function MissionControlPage() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [generation, setGeneration] = useState(0);
  const [blocked, setBlocked] = useState(false);
  useEffect(
    () =>
      answerSignRequests(() => frame.current?.contentWindow, browserSignEvent),
    [],
  );
  // The host's Content-Security-Policy decides whether the frame may load.
  useEffect(() => {
    const url = missionControlUrl();
    const listener = (event: SecurityPolicyViolationEvent) => {
      if (
        event.effectiveDirective === "frame-src" &&
        event.blockedURI.startsWith(url)
      )
        setBlocked(true);
    };
    document.addEventListener("securitypolicyviolation", listener);
    return () =>
      document.removeEventListener("securitypolicyviolation", listener);
  }, []);
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Mission Control">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title="Mission Control"
            actions={
              <IconButton
                aria-label="Reload Mission Control"
                size="sm"
                icon={<ArrowClockwiseIcon size={16} aria-hidden="true" />}
                onClick={() => setGeneration((value) => value + 1)}
              />
            }
          />
          {blocked ? (
            <EmptyState
              icon={<ShieldIcon />}
              title="This server blocks Mission Control"
              description="Its Content-Security-Policy forbids frames. In the web host's nginx site, change frame-src 'none' to frame-src 'self' and reload nginx."
            />
          ) : (
            <iframe
              key={generation}
              ref={frame}
              title="Mission Control"
              src={missionControlUrl()}
              className="min-h-0 w-full flex-1 border-0"
            />
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}
