import type { Session } from '../auth/session'

const BASE_URL = 'https://www.humblebundle.com'

export type OrderResponse = {
  product: {
    human_name: string
  }
  subproducts: Array<{
    human_name: string
    downloads: Array<{
      platform: string
      download_struct: Array<{
        url?: {
          web?: string
        }
        file_size?: number
        md5?: string
        asm_config?: {
          display_item?: string
        }
        asm_manifest?: {
          asmFile?: string
        }
        external_link?: string
      }>
    }>
  }>
}

export type TroveProduct = {
  'human-name': string
  date_added?: string
  downloads: Record<
    string,
    {
      machine_name: string
      md5?: string
      timestamp?: string
      uploaded_at?: string
      url: {
        web: string
      }
    }
  >
}

export type TroveSignResponse = {
  signed_url?: string
  _errors?: string
}

/**
 * Contract for API access helpers.
 */
export type ApiClient = {
  session: Session
  fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>
  fetchText: (url: string, init?: RequestInit) => Promise<string>
  getLibraryPage: () => Promise<string>
  getOrderDetails: (orderId: string) => Promise<OrderResponse>
  getTroveProducts: () => Promise<TroveProduct[]>
  signTroveDownload: (machineName: string, filename: string) => Promise<TroveSignResponse>
}

function buildHeaders(session: Session, initHeaders?: HeadersInit): HeadersInit {
  const headers = new Headers(initHeaders)
  headers.set('User-Agent', 'humblebundle-downloader-ts')

  if (session.cookieHeader) {
    headers.set('cookie', session.cookieHeader)
  }

  return headers
}

/**
 * Build an API client instance that can be expanded with authenticated
 * requests once cookie handling is implemented.
 */
export function createClient(session: Session): ApiClient {
  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: buildHeaders(session, init?.headers),
    })

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as T
  }

  async function fetchText(url: string, init?: RequestInit): Promise<string> {
    const response = await fetch(url, {
      ...init,
      headers: buildHeaders(session, init?.headers),
    })

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }

    return response.text()
  }

  async function getLibraryPage(): Promise<string> {
    return fetchText(`${BASE_URL}/home/library`)
  }

  async function getOrderDetails(orderId: string): Promise<OrderResponse> {
    return fetchJson<OrderResponse>(`${BASE_URL}/api/v1/order/${orderId}?all_tpkds=true`, {
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
    })
  }

  async function getTroveProducts(): Promise<TroveProduct[]> {
    const products: TroveProduct[] = []
    let index = 0
    let hasMore = true

    while (hasMore) {
      const page = await fetchJson<TroveProduct[]>(`${BASE_URL}/client/catalog?index=${index}`)

      if (page.length === 0) {
        hasMore = false
        continue
      }

      products.push(...page)
      index += 1
    }

    return products
  }

  async function signTroveDownload(
    machineName: string,
    filename: string
  ): Promise<TroveSignResponse> {
    const form = new URLSearchParams({
      machine_name: machineName,
      filename,
    })

    return fetchJson<TroveSignResponse>(`${BASE_URL}/api/v1/user/download/sign`, {
      method: 'POST',
      body: form,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
    })
  }

  return {
    session,
    fetchJson,
    fetchText,
    getLibraryPage,
    getOrderDetails,
    getTroveProducts,
    signTroveDownload,
  }
}
