/**
 * Full-screen Pixel Office — used in the pop-out window.
 * No panel chrome, no resize handle. Just the canvas filling the entire window.
 */

import PhaserOfficeCanvas from './PhaserOfficeCanvas'

export default function PixelOfficeFullscreen(): React.JSX.Element {
  return (
    <div className="w-screen h-screen bg-[#0a0a14]">
      <PhaserOfficeCanvas />
    </div>
  )
}
