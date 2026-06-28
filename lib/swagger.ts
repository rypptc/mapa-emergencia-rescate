/**
 * Configuración central de OpenAPI/Swagger.
 *
 * Usa `next-swagger-doc` (el estándar para Next App Router): escanea `app/api`
 * y arma la spec a partir de los bloques JSDoc `@swagger` de cada route. Agregar
 * un endpoint nuevo lo auto-registra en cuanto lleve su comentario `@swagger`
 * (documentation-as-code).
 *
 * IMPORTANTE: la app corre con `output: standalone`, así que los fuentes de
 * `app/api/**` NO están en el contenedor en runtime. Por eso la spec se genera
 * en BUILD (scripts/gen-openapi.mts -> public/openapi.json) y se sirve estática.
 * Este helper es lo que ese script (y dev) usan para construirla.
 */
import { createSwaggerSpec } from "next-swagger-doc";

export function buildOpenApiSpec(): Record<string, unknown> {
  return createSwaggerSpec({
    apiFolder: "app/api",
    definition: {
      openapi: "3.0.0",
      info: {
        title: "Mapa de Emergencia y Rescate — API",
        version: "1.0.0",
        description:
          "API pública/admin del mapa de emergencia. Documentación generada " +
          "automáticamente desde los bloques @swagger de cada route.",
      },
      tags: [
        { name: "reports", description: "Reportes de emergencia en el mapa" },
        { name: "missing", description: "Personas desaparecidas / localizadas" },
        { name: "hospitals", description: "Hospitales y pacientes" },
        { name: "admin", description: "Superficie restringida de administración" },
        { name: "donations", description: "Donaciones" },
        { name: "chat", description: "Chat ciudadano" },
        { name: "sync", description: "Sincronización de fuentes externas" },
        { name: "hub", description: "Federación con el hub central (otros sitios, READ-ONLY)" },
        { name: "system", description: "Salud y utilidades" },
      ],
      components: { schemas: SCHEMAS },
    },
  }) as Record<string, unknown>;
}

/**
 * Modelos (DTO) reutilizables, espejo de los tipos públicos que devuelven los
 * endpoints (lib/types.ts, lib/missing.ts, lib/hospitals-meta.ts,
 * lib/donation-shared.ts, lib/chat-types.ts). Los bloques @swagger de cada route
 * referencian estos con `$ref: '#/components/schemas/<Nombre>'`.
 */
const SCHEMAS = {
  Error: {
    type: "object",
    properties: { error: { type: "string" } },
  },
  EmergencyReport: {
    type: "object",
    properties: {
      id: { type: "string" },
      type: {
        type: "string",
        enum: ["critical", "supplies", "shelter", "nopower", "missing", "building"],
      },
      lat: { type: "number" },
      lng: { type: "number" },
      place: { type: "string" },
      affected: { type: "integer" },
      needs: { type: "string" },
      photoUrl: { type: "string", nullable: true },
      confirmations: { type: "integer" },
      createdAt: { type: "integer", description: "epoch-ms" },
    },
  },
  MissingPerson: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      age: { type: "integer", nullable: true },
      nationality: { type: "string", nullable: true },
      description: { type: "string" },
      lastSeen: { type: "string" },
      contact: { type: "string" },
      photoUrl: { type: "string", nullable: true },
      status: { type: "string", enum: ["active", "found"] },
      resolutionNote: { type: "string", nullable: true },
      resolutionPhotoUrl: { type: "string", nullable: true },
      resolvedAt: { type: "integer", nullable: true },
      createdAt: { type: "integer", description: "epoch-ms" },
    },
  },
  MissingMapMarker: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      age: { type: "integer", nullable: true },
      lastSeen: { type: "string" },
      photoUrl: { type: "string", nullable: true },
      lat: { type: "number" },
      lng: { type: "number" },
      createdAt: { type: "integer" },
    },
  },
  MissingStats: {
    type: "object",
    properties: {
      active: { type: "integer" },
      found: { type: "integer" },
      total: { type: "integer" },
      onMap: { type: "integer" },
    },
  },
  Hospital: {
    type: "object",
    properties: {
      id: { type: "string" },
      externalId: { type: "string", nullable: true },
      name: { type: "string" },
      facilityType: { type: "string" },
      state: { type: "string" },
      municipality: { type: "string" },
      address: { type: "string" },
      level: { type: "string", nullable: true },
      priorityZone: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
      isPriority: { type: "boolean" },
      activePatients: { type: "integer" },
      totalPatients: { type: "integer" },
      createdAt: { type: "integer" },
      supplySummary: {
        nullable: true,
        $ref: "#/components/schemas/HospitalSupplySummary",
      },
    },
  },
  HospitalPatient: {
    type: "object",
    properties: {
      id: { type: "string" },
      hospitalId: { type: "string" },
      name: { type: "string" },
      age: { type: "integer", nullable: true },
      condition: { type: "string" },
      status: { type: "string" },
      notes: { type: "string" },
      contact: { type: "string" },
      admittedAt: { type: "integer" },
      updatedAt: { type: "integer" },
    },
  },
  HospitalSupplyFreshness: {
    type: "object",
    properties: {
      lastUpdatedAt: { type: "integer", description: "epoch-ms" },
      lastConfirmedAt: { type: "integer", description: "epoch-ms" },
      staleAfterHours: { type: "integer" },
      isStale: { type: "boolean" },
      updatedAgo: { type: "string" },
      confirmedAgo: { type: "string" },
    },
  },
  HospitalSupplyCategory: {
    type: "string",
    enum: [
      "medications",
      "iv_fluids",
      "medical_supplies",
      "soft_foods",
      "water",
      "beds_capacity",
      "lab_diagnostics",
      "transport",
      "other",
    ],
  },
  HospitalSupplySemaphore: {
    type: "string",
    enum: ["green", "yellow", "red", "unknown"],
  },
  HospitalSupplyUrgencySemaphore: {
    type: "string",
    enum: ["yellow", "red", "unknown"],
    description:
      "Urgencia permitida para necesidades activas; verde se reserva para semáforos sin necesidad crítica.",
  },
  HospitalSupplyCategoryStatus: {
    type: "object",
    properties: {
      category: { $ref: "#/components/schemas/HospitalSupplyCategory" },
      status: { $ref: "#/components/schemas/HospitalSupplySemaphore" },
      label: { type: "string" },
      publicNote: { type: "string" },
      freshness: { $ref: "#/components/schemas/HospitalSupplyFreshness" },
    },
  },
  HospitalSupplyStatus: {
    allOf: [
      { $ref: "#/components/schemas/HospitalSupplyCategoryStatus" },
      {
        type: "object",
        properties: {
          id: { type: "string" },
          hospitalId: { type: "string" },
          restrictedNote: { type: "string" },
          updatedBy: { type: "string" },
          source: { type: "string" },
        },
      },
    ],
  },
  HospitalSupplyNeed: {
    type: "object",
    properties: {
      id: { type: "string" },
      hospitalId: { type: "string" },
      category: { $ref: "#/components/schemas/HospitalSupplyCategory" },
      categoryLabel: { type: "string" },
      itemType: { type: "string" },
      quantity: { type: "integer", nullable: true },
      unit: { type: "string" },
      urgency: { $ref: "#/components/schemas/HospitalSupplyUrgencySemaphore" },
      status: {
        type: "string",
        enum: [
          "active",
          "partially_covered",
          "covered",
          "cancelled",
          "needs_verification",
        ],
      },
      publicNote: { type: "string" },
      lastConfirmedAt: { type: "integer" },
      updatedAt: { type: "integer" },
      updatedAgo: { type: "string" },
    },
  },
  HospitalSupplyNeedRestricted: {
    allOf: [
      { $ref: "#/components/schemas/HospitalSupplyNeed" },
      {
        type: "object",
        properties: {
          restrictedNote: { type: "string" },
          updatedBy: { type: "string" },
          source: { type: "string" },
          createdAt: { type: "integer" },
        },
      },
    ],
  },
  HospitalSupplySummary: {
    type: "object",
    properties: {
      statuses: {
        type: "array",
        items: { $ref: "#/components/schemas/HospitalSupplyCategoryStatus" },
      },
      activeNeeds: {
        type: "array",
        items: { $ref: "#/components/schemas/HospitalSupplyNeed" },
      },
      counts: {
        type: "object",
        properties: {
          red: { type: "integer" },
          yellow: { type: "integer" },
          stale: { type: "integer" },
          activeNeeds: { type: "integer" },
        },
      },
      worstStatus: { $ref: "#/components/schemas/HospitalSupplySemaphore" },
      lastConfirmedAt: { type: "integer", nullable: true },
    },
  },
  HospitalSupplyStatusUpdateInput: {
    type: "object",
    required: ["category"],
    oneOf: [
      {
        required: ["category", "status"],
        properties: {
          confirmOnly: { enum: [false] },
        },
      },
      {
        required: ["category", "confirmOnly"],
        properties: {
          confirmOnly: { enum: [true] },
        },
      },
    ],
    properties: {
      category: { $ref: "#/components/schemas/HospitalSupplyCategory" },
      status: { $ref: "#/components/schemas/HospitalSupplySemaphore" },
      publicNote: { type: "string" },
      restrictedNote: { type: "string" },
      staleAfterHours: { type: "integer", minimum: 1, maximum: 168 },
      updatedBy: { type: "string" },
      source: { type: "string" },
      confirmOnly: {
        type: "boolean",
        description: "true para renovar frescura sin cambiar el semáforo.",
      },
    },
  },
  HospitalSupplyNeedInput: {
    type: "object",
    required: ["category", "itemType"],
    properties: {
      category: { $ref: "#/components/schemas/HospitalSupplyCategory" },
      itemType: { type: "string" },
      quantity: { type: "integer", nullable: true },
      unit: { type: "string" },
      urgency: { $ref: "#/components/schemas/HospitalSupplyUrgencySemaphore" },
      status: {
        type: "string",
        enum: [
          "active",
          "partially_covered",
          "covered",
          "cancelled",
          "needs_verification",
        ],
      },
      publicNote: { type: "string" },
      restrictedNote: { type: "string" },
      updatedBy: { type: "string" },
      source: { type: "string" },
    },
  },
  HospitalSupplyNeedPatchInput: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: [
          "active",
          "partially_covered",
          "covered",
          "cancelled",
          "needs_verification",
        ],
      },
      publicNote: { type: "string" },
      restrictedNote: { type: "string" },
      updatedBy: { type: "string" },
      source: { type: "string" },
    },
  },
  HospitalSupplyHelpRequest: {
    type: "object",
    properties: {
      id: { type: "string" },
      hospitalId: { type: "string" },
      category: { $ref: "#/components/schemas/HospitalSupplyCategory" },
      categoryLabel: { type: "string" },
      message: { type: "string" },
      urgency: { $ref: "#/components/schemas/HospitalSupplyUrgencySemaphore" },
      status: {
        type: "string",
        enum: ["open", "contacting", "resolved", "closed"],
      },
      requestedBy: { type: "string" },
      source: { type: "string" },
      restrictedNote: { type: "string" },
      createdAt: { type: "integer" },
      updatedAt: { type: "integer" },
      updatedAgo: { type: "string" },
    },
  },
  HospitalSupplyHelpRequestInput: {
    type: "object",
    required: ["category", "message"],
    properties: {
      category: { $ref: "#/components/schemas/HospitalSupplyCategory" },
      message: { type: "string" },
      urgency: { $ref: "#/components/schemas/HospitalSupplyUrgencySemaphore" },
      requestedBy: { type: "string" },
      source: { type: "string" },
      restrictedNote: { type: "string" },
    },
  },
  HospitalSupplyHelpPatchInput: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["open", "contacting", "resolved", "closed"],
      },
      restrictedNote: { type: "string" },
      requestedBy: { type: "string" },
      source: { type: "string" },
    },
  },
  HospitalPocAssignment: {
    type: "object",
    properties: {
      id: { type: "string" },
      hospitalId: { type: "string" },
      displayName: { type: "string" },
      role: {
        type: "string",
        enum: ["operator_admin", "hospital_poc", "ops_reader"],
      },
      restrictedContact: { type: "string" },
      active: { type: "boolean" },
      createdAt: { type: "integer" },
      updatedAt: { type: "integer" },
    },
  },
  AdminHospitalSupplyRow: {
    type: "object",
    properties: {
      hospital: { $ref: "#/components/schemas/Hospital" },
      supply: {
        type: "object",
        properties: {
          hospitalId: { type: "string" },
          summary: { $ref: "#/components/schemas/HospitalSupplySummary" },
          statuses: {
            type: "array",
            items: { $ref: "#/components/schemas/HospitalSupplyStatus" },
          },
          activeNeeds: {
            type: "array",
            items: { $ref: "#/components/schemas/HospitalSupplyNeedRestricted" },
          },
          helpRequests: {
            type: "array",
            items: { $ref: "#/components/schemas/HospitalSupplyHelpRequest" },
          },
          pocs: {
            type: "array",
            items: { $ref: "#/components/schemas/HospitalPocAssignment" },
          },
        },
      },
    },
  },
  Donation: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      amountCents: { type: "integer" },
      createdAt: { type: "integer" },
      status: { type: "string", enum: ["intent", "completed"] },
    },
  },
  DonationStats: {
    type: "object",
    properties: {
      count: { type: "integer" },
      totalCents: { type: "integer" },
      last24hCount: { type: "integer" },
      last24hCents: { type: "integer" },
    },
  },
  ChatMessage: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      text: { type: "string" },
      createdAt: { type: "integer" },
      replyTo: { type: "string", nullable: true },
      replyPreview: { type: "string", nullable: true },
      threadRootId: { type: "string" },
      threadBumpedAt: { type: "integer" },
    },
  },
} as const;
