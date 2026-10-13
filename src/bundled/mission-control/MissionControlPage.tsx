import { useEffect, useRef, useState } from "react";
import { browserSignEvent } from "../../features/identity/browser";
import { ArrowClockwiseIcon } from "../../shared/design-system/icons";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { answerSignRequests, missionControlUrl } from "./signing";

/** team-builder's Mission Control in a same-origin frame. The dashboard asks this
 * page to sign its owner challenges, so the owner signs in with their Buzz key. */
export function MissionControlPage() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(
    () =>
      answerSignRequests(() => frame.current?.contentWindow, browserSignEvent),
    [],
  );
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
          <iframe
            key={generation}
            ref={frame}
            title="Mission Control"
            src={missionControlUrl()}
            className="min-h-0 w-full flex-1 border-0"
          />
        </div>
      </FullPageSurface>
    </div>
  );
}
