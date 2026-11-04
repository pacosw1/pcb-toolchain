// The engine process: `engineMain serve`. The app starts it and owns it through its stdin.
import { serve } from './server.ts'

serve().then(() => process.exit(0), (e: unknown) => {
  console.error(e)
  process.exit(1)
})
