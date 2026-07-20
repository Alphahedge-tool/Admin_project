// Broker logo lookup, kept out of BrokerMark.jsx so that file exports only its
// component and React Fast Refresh keeps working.
import angelOneLogo from '../assets/angel-one-logo.svg'
import kotakNeoLogo from '../assets/kotak-neo-logo.svg'
import zerodhaKiteLogo from '../assets/zerodha-kite-logo.svg'

export function brokerArtwork(name = '') {
  const normalized = String(name)
  if (/angel/i.test(normalized)) return { id: 'angel', label: 'Angel One', src: angelOneLogo }
  if (/kotak/i.test(normalized)) return { id: 'kotak', label: 'Kotak Neo', src: kotakNeoLogo }
  if (/zerodha|kite/i.test(normalized)) return { id: 'zerodha', label: 'Zerodha Kite', src: zerodhaKiteLogo }
  return null
}

// Lets callers decide whether a name will actually produce a logo, so they can
// fall back to their own mark instead of rendering an empty gap.
export function hasBrokerArtwork(name) {
  return brokerArtwork(name) !== null
}
