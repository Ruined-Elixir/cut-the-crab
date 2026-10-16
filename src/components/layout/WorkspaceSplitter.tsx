import type { useWorkspaceLayout } from "../../hooks/useWorkspaceLayout";
import type { SplitterId } from "../../utils/workspaceLayout";

import "./WorkspaceSplitter.css";

type WorkspaceSplitterProps = {
  id: SplitterId;
  layout: ReturnType<typeof useWorkspaceLayout>;
};

/*
 * A draggable divider. It takes no space (zero width or height); the larger
 * hit area and the highlight line are drawn around it.
 */
function WorkspaceSplitter({ id, layout }: WorkspaceSplitterProps) {
  const orientation = id === "timeline" ? "horizontal" : "vertical";

  return (
    <div
      className={[
        "ws-splitter",
        `ws-splitter-${orientation}`,
        `ws-splitter-${id}`,
        layout.dragging === id ? "dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...layout.splitterProps(id)}
    >
      <span className="ws-splitter-hit" aria-hidden="true" />
    </div>
  );
}

export default WorkspaceSplitter;
