# Seguridad

## Dónde viven tus credenciales

GCenter **nunca** guarda API keys dentro del proyecto. Las llaves que pegas en
Ajustes se escriben en tu perfil de usuario, fuera de cualquier repositorio:

| Sistema | Ruta |
|---|---|
| Windows | `%APPDATA%\GCenter\config.json` |
| Linux / macOS | `~/.config/gcenter/config.json` |

Si prefieres no escribirlas en disco, puedes exportarlas como variables de
entorno (`GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
`NVIDIA_API_KEY`, `MISTRAL_API_KEY`): tienen prioridad sobre el archivo.

## Qué puede hacer la aplicación en tu equipo

- **Escrituras confinadas.** Los agentes solo pueden escribir dentro del
  directorio de trabajo elegido; cualquier ruta que intente salir de él se
  rechaza. Si un archivo ya existía, se guarda una copia en
  `%APPDATA%\GCenter\backups\` antes de sobrescribirlo.
- **Respeto a los modos supervisados.** En los modos *Plan*, *Manual* y
  *No preguntar*, GCenter no escribe archivos por su cuenta: devuelve el
  contenido y decide Claude.
- **Telemetría local.** El canal entre el servidor MCP y la interfaz escucha
  solo en `127.0.0.1` y exige un token aleatorio que se regenera en cada
  arranque.
- **Sin cargos.** La barrera de gratuidad rechaza cualquier modelo de pago
  antes de llamar al proveedor (ver el README).

## Lo que conviene saber de los proveedores gratuitos

Varios proveedores declaran que **pueden usar los prompts del tier gratuito
para entrenar o mejorar sus modelos**. No delegues código ni datos que no
quieras compartir con terceros.

## Informar de una vulnerabilidad

No abras un issue público. Usa la opción
[**Report a vulnerability**](https://github.com/toroc07/gcenter/security/advisories/new)
de la pestaña *Security* del repositorio, que crea un aviso privado.
