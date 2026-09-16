import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error('Supabase 연결 정보가 없습니다. 환경변수를 확인해 주세요.')
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey)
