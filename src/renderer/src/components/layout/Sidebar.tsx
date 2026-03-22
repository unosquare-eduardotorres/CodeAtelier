interface SidebarProps {
  children: React.ReactNode;
}

export default function Sidebar({ children }: SidebarProps): React.JSX.Element {
  return <div className="flex-shrink-0 h-full overflow-visible">{children}</div>;
}
