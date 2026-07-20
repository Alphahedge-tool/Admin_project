import { brokerArtwork } from './brokerArtwork'

export function BrokerMark({ brokerName, className = '' }) {
  const artwork = brokerArtwork(brokerName)
  if (!artwork) return null

  return (
    <span
      className={`broker-mark broker-mark--${artwork.id}${className ? ` ${className}` : ''}`}
      title={artwork.label}
      aria-label={artwork.label}
    >
      <img src={artwork.src} alt="" aria-hidden="true" />
    </span>
  )
}
