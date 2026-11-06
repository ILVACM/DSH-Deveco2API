/** 设置分区图标：16px 简约 SVG，接收 { size, active }。 */
import * as React from 'react'

export function PluginIcon(props: { size?: number; active?: boolean }): React.ReactElement {
  const size = typeof props?.size === 'number' ? props.size : 16
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
  },
  React.createElement('rect', { x: 2, y: 3, width: 12, height: 8, rx: 1.5 }),
  React.createElement('path', { d: 'M4 14h8' }))
}
export default PluginIcon
