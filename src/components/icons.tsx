import type { JSX } from "solid-js";

const Svg = (props: { children: JSX.Element; size?: number }) => (
  <svg aria-hidden="true" width={props.size ?? 20} height={props.size ?? 20} viewBox="0 0 24 24" class="icon">
    {props.children}
  </svg>
);

export const FileIcon = () => (
  <Svg>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);

export const GitIcon = () => (
  <Svg>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="8" r="2" />
    <path d="M6 7v10" />
    <path d="M18 10v2a5 5 0 0 1-5 5H8" />
  </Svg>
);

export const WorktreeIcon = () => (
  <Svg>
    <rect x="3" y="4" width="7" height="6" rx="1" />
    <rect x="14" y="4" width="7" height="6" rx="1" />
    <rect x="14" y="14" width="7" height="6" rx="1" />
    <path d="M10 7h4" />
    <path d="M12 7v10h2" />
  </Svg>
);
