interface PanelContainerProps {
  children: React.ReactNode
  isVisible: boolean
  width?: string
}

export default function PanelContainer({
  children,
  isVisible,
  width = 'w-[350px]'
}: PanelContainerProps): React.JSX.Element {
  if (!isVisible) return <></>

  return (
    <div
      className={`flex-shrink-0 ${width} h-full`}
      role="complementary"
      aria-label="Agent monitor panel"
    >
      {children}
    </div>
  )
}
