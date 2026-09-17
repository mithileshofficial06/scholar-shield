import type { SVGProps } from 'react';

/**
 * Line icons drawn on one 24px grid with one stroke weight, so they sit
 * together without an icon library in the bundle.
 */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ArrowIcon = () => (
  <Icon>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon strokeWidth="2.4">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const CrossIcon = () => (
  <Icon strokeWidth="2.4">
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const ScanIcon = () => (
  <Icon>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10" />
  </Icon>
);

export const ForensicsIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.2-4.2M9 11h4M11 9v4" />
  </Icon>
);

export const LinkIcon = () => (
  <Icon>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Icon>
);

export const GraphIcon = () => (
  <Icon>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="12" cy="18" r="2.5" />
    <path d="M8.5 6h7M7.3 8.2l3.4 7.6M16.7 8.2l-3.4 7.6" />
  </Icon>
);

export const ScaleIcon = () => (
  <Icon>
    <path d="M12 4v16M8 20h8M5 8h14M5 8l-2.5 6a3 3 0 0 0 5 0L5 8Zm14 0-2.5 6a3 3 0 0 0 5 0L19 8Z" />
  </Icon>
);

export const EyeIcon = () => (
  <Icon>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const DatabaseIcon = () => (
  <Icon>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
  </Icon>
);

export const LockIcon = () => (
  <Icon>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const MessageIcon = () => (
  <Icon>
    <path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM8 9.5h8M8 12.5h5" />
  </Icon>
);

export const UsersIcon = () => (
  <Icon>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20a6 6 0 0 1 12 0M16 4.6a3.5 3.5 0 0 1 0 6.8M21 20a6 6 0 0 0-3.5-5.5" />
  </Icon>
);

export const UploadIcon = () => (
  <Icon>
    <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </Icon>
);

export const AlertIcon = () => (
  <Icon>
    <path d="M12 4 2.8 19.5h18.4L12 4Z" />
    <path d="M12 10v4.5M12 17.2v.3" />
  </Icon>
);

export const ServerIcon = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="7" rx="1.5" />
    <rect x="4" y="13" width="16" height="7" rx="1.5" />
    <path d="M8 7.5h.01M8 16.5h.01" />
  </Icon>
);
