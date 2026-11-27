{{- define "opencrane.memberKeyVolumes" -}}
{{- range . }}
- name: {{ . }}
  persistentVolumeClaim: { claimName: {{ . }} }
{{- end }}
{{- end }}

{{- define "opencrane.memberKeyMounts" -}}
{{- range .volumes }}
- { name: {{ . }}, mountPath: /var/lib/opencrane/{{ . }}, readOnly: {{ $.readOnly }} }
{{- end }}
{{- end }}

{{- define "opencrane.memberKeyInit" -}}
- name: {{ .name }}
  image: {{ .image | quote }}
  command:
    - node
    - infra/package/provider-secrets.mjs
    - --directory-only
    {{- range .volumes }}
    - /var/lib/opencrane/{{ . }}
    {{- end }}
  securityContext:
    runAsUser: 0
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
  volumeMounts:
    {{- range .volumes }}
    - { name: {{ . }}, mountPath: /var/lib/opencrane/{{ . }} }
    {{- end }}
  resources:
    requests: { cpu: 10m, memory: 32Mi }
    limits: { cpu: 50m, memory: 64Mi }
{{- end }}

{{- define "opencrane.memoryKeyEnvironment" -}}
- { name: MEMORY_KEY_DIRECTORY, value: /var/lib/opencrane/memory-secrets/keys }
- { name: MEMORY_PROJECTION_SCHEMA, value: opencrane_memory }
{{- end }}
