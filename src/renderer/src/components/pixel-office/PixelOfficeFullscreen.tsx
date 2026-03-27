/**
 * Full-screen Pixel Office — used in the pop-out window.
 * No panel chrome, no resize handle. Just the canvas filling the entire window.
 */

import OfficeCanvas from './OfficeCanvas'

export default function PixelOfficeFullscreen(): React.JSX.Element {
  return (
    <div className="w-screen h-screen bg-gray-950">
      <OfficeCanvas />
    </div>
  )
}
