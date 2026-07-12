import type { ComponentChildren } from "preact";
import { useLocation } from "preact-iso";

interface NavLinkProps {
  active: boolean;
  children: ComponentChildren;
  className?: string;
  href: string;
}

/**
 * A client-side navigation anchor: renders a real `<a href>` (so it degrades and is inspectable) but
 * intercepts clicks to route through `preact-iso` without a full page load. Marks itself
 * `aria-current="page"` when `active`, and takes an optional `className` override for non-nav uses
 * (e.g. the mobile back button).
 */
export function NavLink({ active, children, className, href }: NavLinkProps) {
  const location = useLocation();
  const linkClassName = className ?? `nav-link${active ? " active" : ""}`;

  return (
    <a
      aria-current={active ? "page" : undefined}
      className={linkClassName}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        location.route(href);
      }}
    >
      {children}
    </a>
  );
}
