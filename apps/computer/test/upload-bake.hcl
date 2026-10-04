group "default" {
  targets = ["computer"]
}

target "base" {
  context = "spikes/s0-1b-proxy-gvisor"
  dockerfile = "../../apps/computer/test/upload-base.Dockerfile"
}

target "computer" {
  context = "apps/computer"
  target = "runtime"
  args = { COMPUTER_BASE = "upload-base" }
  contexts = {
    upload-base = "target:base"
    project = "."
  }
  tags = ["ocn-upload-computer:test"]
}
