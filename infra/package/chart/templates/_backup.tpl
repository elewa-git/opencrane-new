{{- define "opencrane.backupReference" -}}
{{- if not (kindIs "map" .) -}}
{{- fail "CNPG backup requires existing Secret references" -}}
{{- end -}}
{{- range $field, $value := . -}}
{{- if not (has $field (list "name" "key")) -}}
{{- fail "CNPG backup accepts only Secret names and keys" -}}
{{- end -}}
{{- end -}}
{{- if not (and (kindIs "string" .name) (le (len .name) 253)
      (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" .name)) -}}
{{- fail "CNPG backup requires a Secret name" -}}
{{- end -}}
{{- if not (and (kindIs "string" .key) (le (len .key) 253)
      (regexMatch "^[-._a-zA-Z0-9]+$" .key)) -}}
{{- fail "CNPG backup requires a Secret key" -}}
{{- end -}}
{{- end -}}

{{- define "opencrane.backupGuard" -}}
{{- if hasKey .Values.postgres "backup" -}}
{{- $backup := .Values.postgres.backup -}}
{{- if not (and (eq .Values.postgres.mode "cnpg") (kindIs "map" $backup)) -}}
{{- fail "CNPG backup requires CNPG mode and explicit preview settings" -}}
{{- end -}}
{{- $allowed := list "enabled" "renderOnly" "method" "destinationPath" "endpointURL"
                    "endpointCA" "s3Credentials" -}}
{{- range $field, $value := $backup -}}
{{- if not (has $field $allowed) -}}
{{- fail "Unsupported CNPG backup setting" -}}
{{- end -}}
{{- end -}}
{{- range $field := list "enabled" "renderOnly" -}}
{{- $value := index $backup $field -}}
{{- if not (and (kindIs "bool" $value) $value) -}}
{{- fail "CNPG backup requires enabled and renderOnly to be true" -}}
{{- end -}}
{{- end -}}
{{- if not (and (kindIs "string" $backup.method) (eq $backup.method "barmanObjectStore")) -}}
{{- fail "CNPG backup requires the native barmanObjectStore method" -}}
{{- end -}}
{{- $destinationPattern := "^s3://[a-z0-9][a-z0-9-]{1,61}[a-z0-9](/[a-zA-Z0-9_-]+)*/?$" -}}
{{- if not (and (kindIs "string" $backup.destinationPath)
      (regexMatch $destinationPattern $backup.destinationPath)) -}}
{{- fail "CNPG backup requires an S3 bucket and optional plain path" -}}
{{- end -}}
{{- $endpointPattern := printf
      "^https://[a-z0-9]([-a-z0-9]*[a-z0-9])?\\.%s\\.svc(\\.cluster\\.local)?(:[0-9]{1,5})?/?$"
      .Release.Namespace -}}
{{- if not (and (kindIs "string" $backup.endpointURL)
      (regexMatch $endpointPattern $backup.endpointURL)) -}}
{{- fail "CNPG backup requires an HTTPS Service endpoint in this namespace" -}}
{{- end -}}
{{- $port := regexFind ":[0-9]+" $backup.endpointURL -}}
{{- if $port -}}
{{- $number := atoi (trimPrefix ":" $port) -}}
{{- if or (lt $number 1) (gt $number 65535) -}}
{{- fail "CNPG backup endpoint port is invalid" -}}
{{- end -}}
{{- end -}}
{{- include "opencrane.backupReference" $backup.endpointCA -}}
{{- $credentials := $backup.s3Credentials -}}
{{- if not (kindIs "map" $credentials) -}}
{{- fail "CNPG backup requires S3 credential references" -}}
{{- end -}}
{{- range $field, $value := $credentials -}}
{{- if not (has $field (list "accessKeyId" "secretAccessKey")) -}}
{{- fail "Unsupported CNPG backup credential setting" -}}
{{- end -}}
{{- end -}}
{{- include "opencrane.backupReference" $credentials.accessKeyId -}}
{{- include "opencrane.backupReference" $credentials.secretAccessKey -}}
{{- end -}}
{{- end -}}
