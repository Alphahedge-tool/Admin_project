import angelOneLogo from '../assets/angel-one-logo.svg'
import kotakNeoLogo from '../assets/kotak-neo-logo.svg'
import zerodhaKiteLogo from '../assets/zerodha-kite-logo.svg'

function brokerArtwork(name = '') {
  const normalized = String(name)
  if (/angel/i.test(normalized)) return { id: 'angel', label: 'Angel One', src: angelOneLogo }
  if (/kotak/i.test(normalized)) return { id: 'kotak', label: 'Kotak Neo', src: kotakNeoLogo }
  if (/zerodha|kite/i.test(normalized)) return { id: 'zerodha', label: 'Zerodha Kite', src: zerodhaKiteLogo }
  return null
}

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
