import customerModel from "../model/customerModel.js";
import priceModel from "../model/priceModel.js";
import temporaryTransporterModel from "../model/temporaryTransporterModel.js";
import transporterModel from "../model/transporterModel.js";
import usertransporterrelationshipModel from "../model/usertransporterrelationshipModel.js";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import packingModel from "../model/packingModel.js";
import ratingModel from "../model/ratingModel.js";
import PackingList from "../model/packingModel.js"; // Make sure model is imported
import VendorZoneMapping from "../model/VendorZoneMapping.js";
import { zoneForPincode } from "../src/utils/pincodeZoneLookup.js"; // Global fallback

import haversineDistanceKm from "../src/utils/haversine.js";
import pinMap from "../src/utils/pincodeMap.js";

import {
  validateZoneMatrix,
  sanitizeZoneCodes,
  validateGSTIN,
  validateEmail,
  validatePhone,
  validatePincode,
  sanitizeString,
} from "../utils/validators.js";

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load pincodes.json once at startup for zone config building
const PINCODES_PATH = path.join(__dirname, "../data/pincodes.json");
let pincodeDataArray = [];
try {
  pincodeDataArray = JSON.parse(fs.readFileSync(PINCODES_PATH, "utf-8"));
  console.log(`[Startup] Loaded ${pincodeDataArray.length} pincodes from pincodes.json`);
} catch (e) {
  console.error("[Startup] Failed to load pincodes.json:", e.message);
}

dotenv.config();

/** Helper: robust access to zoneRates whether Map or plain object */
// helper: safe get unit price from various chart shapes and zone key cases
function getUnitPriceFromPriceChart(priceChart, originZoneCode, destZoneCode) {
  if (!priceChart || !originZoneCode || !destZoneCode) return null;
  const o = String(originZoneCode).trim().toUpperCase();
  const d = String(destZoneCode).trim().toUpperCase();

  // common shapes:
  // 1) priceChart[originZone][destZone]
  // 2) priceChart[originZone+destZone] (unlikely)
  // 3) priceChart is Map-like (handled by getUnitPriceFromChart)
  // try multiple fallbacks
  const direct =
    (priceChart[o] && priceChart[o][d]) ??
    (priceChart[d] && priceChart[d][o]);
  if (direct != null) return direct;

  // attempt case-insensitive search on top level keys
  const keys = Object.keys(priceChart || {});
  for (const k of keys) {
    if (String(k).trim().toUpperCase() === o) {
      const row = priceChart[k] || {};
      const val = row[d] ?? row[String(destZoneCode)];
      if (val != null) return val;
    }
    if (String(k).trim().toUpperCase() === d) {
      const row = priceChart[k] || {};
      const val = row[o] ?? row[String(originZoneCode)];
      if (val != null) return val;
    }
  }

  // give up
  return null;
}

export const deletePackingList = async (req, res) => {
  try {
    const preset = await PackingList.findById(req.params.id);

    if (!preset) {
      return res.status(404).json({ message: "Preset not found" });
    }

    await preset.deleteOne();

    res.status(200).json({ message: "Preset deleted successfully" });
  } catch (error) {
    console.error("Error deleting preset:", error);
    res.status(500).json({ message: "Server error while deleting preset." });
  }
};

const calculateDistanceBetweenPincode = async (origin, destination) => {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&key=${process.env.GOOGLE_MAP_API_KEY}`
    );
    if (!response?.data || response.data.status !== "OK") {
      throw new Error(`Bad response from Google: ${response?.data?.status || 'no-data'}`);
    }
    const estTime = (
      response.data.rows[0].elements[0].distance.value / 400000
    ).toFixed(2);
    const distance = response.data.rows[0].elements[0].distance.text;
    return { estTime: estTime, distance: distance };
  } catch (error) {
    console.log(
      "Google Maps API failed, using pincode coordinates fallback:",
      error.message
    );

    // Fallback to pincode coordinates calculation
    try {
      const originStr = String(origin);
      const destStr = String(destination);

      const originCoords = pinMap[originStr];
      const destCoords = pinMap[destStr];

      if (!originCoords || !destCoords) {
        console.warn(
          `Pincode coordinates not found for ${originStr} or ${destStr}`
        );
        return { estTime: "1", distance: "100 km" }; // Safe fallback
      }

      const distanceKm = haversineDistanceKm(
        originCoords.lat,
        originCoords.lng,
        destCoords.lat,
        destCoords.lng
      );

      const estTime = Math.max(1, Math.ceil(distanceKm / 400));

      return {
        estTime: estTime.toString(),
        distance: `${Math.round(distanceKm)} km`,
      };
    } catch (fallbackError) {
      console.error("Fallback distance calculation also failed:", fallbackError);
      return { estTime: "1", distance: "100 km" }; // Safe fallback
    }
  }
};

// -----------------------------
// Helper functions
// -----------------------------
function clampNumber(v, min, max) {
  let n = Number(v || 0);
  if (typeof min === "number" && Number.isFinite(min)) n = Math.max(n, min);
  if (typeof max === "number" && Number.isFinite(max)) n = Math.min(n, max);
  return Math.round(n); // return rupee-rounded integer
}

/**
 * ✅ Calculate invoice value based charges
 * Logic: MAX( (InvoiceValue * Percentage / 100), MinimumAmount )
 */
function calculateInvoiceValueCharge(invoiceValue, invoiceValueCharges) {
  // If not enabled or no invoice value, return 0
  if (!invoiceValueCharges?.enabled || !invoiceValue || invoiceValue <= 0) {
    return 0;
  }

  const { percentage, minimumAmount } = invoiceValueCharges;

  // Calculate percentage-based charge
  const percentageCharge = (invoiceValue * (percentage || 0)) / 100;

  // Return MAX of percentage charge or minimum amount
  const finalCharge = Math.max(percentageCharge, minimumAmount || 0);

  return Math.round(finalCharge); // Return rounded rupee amount
}

/**
 * applyInvoiceRule(ruleObject, invoiceValue, ctx)
 * - ruleObject: a small JSON DSL object stored on vendor/price doc (see examples below)
 * - invoiceValue: numeric invoice value (rupees)
 * - ctx: { mode, totalWeight, distance, chargeableWeight, etc. }
 *
 * Supported rule types: "percentage", "flat", "per_unit", "slab", "conditional", "composite"
 * This is purposely conservative and avoids eval() / insecure operations.
 */
function applyInvoiceRule(rule, invoiceValue, ctx = {}) {
  if (!rule) return 0;
  try {
    const type = (rule.type || "").toString().toLowerCase();
    switch (type) {
      case "percentage": {
        const pct = Number(rule.percent || rule.percentage || 0);
        const raw = invoiceValue * (pct / 100);
        return clampNumber(raw, rule.min, rule.max);
      }
      case "flat": {
        return clampNumber(Number(rule.amount || 0), rule.min, rule.max);
      }
      case "per_unit": {
        const unit = Number(rule.unit || rule.unitAmount || 1);
        const amt = Number(rule.amount_per_unit || rule.amount || 0);
        if (unit <= 0) return 0;
        // default: round up units
        const units = rule.round_up
          ? Math.ceil(invoiceValue / unit)
          : Math.floor(invoiceValue / unit);
        const raw = units * amt;
        return clampNumber(raw, rule.min, rule.max);
      }
      case "slab": {
        const slabs = Array.isArray(rule.slabs) ? rule.slabs : [];
        const found = slabs.find((s) => {
          const min = s.min ?? -Infinity;
          const max = s.max ?? Infinity;
          return invoiceValue >= min && invoiceValue <= max;
        });
        if (!found) return 0;
        const pct = Number(found.percent || 0);
        const raw = invoiceValue * (pct / 100);
        return clampNumber(raw, rule.min ?? found.min, rule.max ?? found.max);
      }
      case "conditional": {
        const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
        for (const c of conds) {
          let ok = true;
          const checks = c.if || {};
          for (const k of Object.keys(checks)) {
            if (ctx[k] == null) {
              ok = false;
              break;
            }
            if (String(ctx[k]) !== String(checks[k])) {
              ok = false;
              break;
            }
          }
          if (ok) return applyInvoiceRule(c.rule, invoiceValue, ctx);
        }
        return applyInvoiceRule(rule.default, invoiceValue, ctx);
      }
      case "composite": {
        const parts = Array.isArray(rule.parts) ? rule.parts : [];
        let total = 0;
        for (const p of parts) total += applyInvoiceRule(p, invoiceValue, ctx);
        return clampNumber(total, rule.min, rule.max);
      }
      default:
        return 0;
    }
  } catch (e) {
    console.warn("applyInvoiceRule error:", e?.message || e);
    return 0;
  }
}

/**
 * Get zone for pincode with vendor-specific lookup first, then global fallback
 * Uses compact zoneConfig format: { N1: ["201301","201302"], N2: [...] }
 */
async function getZoneForPincode(vendorId, pincode, vendorZoneConfig = null) {
  const pincodeStr = String(pincode).trim();
  
  // Validate pincode format
  if (!/^[1-9]\d{5}$/.test(pincodeStr)) {
    console.warn(`[ZoneLookup] Invalid pincode format: ${pincodeStr}`);
    return { zone: null, isOda: false, source: 'invalid' };
  }

  // ===== STEP 1: Try vendor-specific mapping from zoneConfig =====
  if (vendorZoneConfig && typeof vendorZoneConfig === 'object') {
    // Handle both Map and plain object
    const entries = vendorZoneConfig instanceof Map 
      ? Array.from(vendorZoneConfig.entries())
      : Object.entries(vendorZoneConfig);
    
    for (const [zoneCode, pincodes] of entries) {
      if (Array.isArray(pincodes) && pincodes.includes(pincodeStr)) {
        console.log(`[ZoneLookup] Vendor zoneConfig found: ${pincodeStr} -> ${zoneCode}`);
        return {
          zone: String(zoneCode).toUpperCase(),
          isOda: false,
          source: 'vendor',
        };
      }
    }
  }

  // ===== STEP 2: Try VendorZoneMapping collection (legacy/fallback) =====
  if (vendorId) {
    try {
      const vendorMapping = await VendorZoneMapping.findZoneForPincode(vendorId, pincodeStr);
      
      if (vendorMapping && vendorMapping.zone) {
        console.log(`[ZoneLookup] VendorZoneMapping collection found: ${pincodeStr} -> ${vendorMapping.zone}`);
        return {
          zone: vendorMapping.zone.toUpperCase(),
          isOda: Boolean(vendorMapping.isOda),
          source: 'vendor_collection',
        };
      }
    } catch (error) {
      // Collection might not exist, continue to fallback
    }
  }

  // ===== STEP 3: Fall back to global zone mapping =====
  try {
    const globalZone = zoneForPincode(pincodeStr);
    
    if (globalZone) {
      console.log(`[ZoneLookup] Global zone used: ${pincodeStr} -> ${globalZone}`);
      return {
        zone: String(globalZone).toUpperCase(),
        isOda: false,
        source: 'global',
      };
    }
  } catch (error) {
    console.error(`[ZoneLookup] Error fetching global zone for ${pincodeStr}:`, error);
  }

  // ===== STEP 4: No zone found =====
  console.warn(`[ZoneLookup] No zone found for pincode ${pincodeStr}`);
  return { zone: null, isOda: false, source: 'not_found' };
}

// -----------------------------
// Main calculatePrice function
// -----------------------------
export const calculatePrice = async (req, res) => {
  const {
    customerID,
    userogpincode,
    modeoftransport,
    fromPincode,
    toPincode,
    noofboxes,
    length,
    width,
    height,
    weight,
    shipment_details,
    invoiceValue: invoiceValueRaw,
  } = req.body;

  const INVOICE_MIN = 1;
  const INVOICE_MAX = 100_000_000;
  const rid = req.id || "no-reqid";

  // ✅ FIX #1: Create per-request cache INSIDE the function (not module-scoped)
  // This prevents memory leaks and ensures cache is cleared after each request
  const zoneCache = new Map();
  
  async function getZoneCached(vendorId, pincode) {
    const key = `${vendorId || 'global'}:${String(pincode).trim()}`;
    if (zoneCache.has(key)) return zoneCache.get(key);
    const val = await getZoneForPincode(vendorId, pincode);
    zoneCache.set(key, val);
    return val;
  }

  // Validate invoice value
  const parsedInvoice = Number(invoiceValueRaw);
  if (
    !Number.isFinite(parsedInvoice) ||
    parsedInvoice < INVOICE_MIN ||
    parsedInvoice > INVOICE_MAX
  ) {
    return res.status(400).json({
      success: false,
      message: `Invalid invoiceValue. Must be a number between ${INVOICE_MIN} and ${INVOICE_MAX}.`,
    });
  }
  const invoiceValue = parsedInvoice;

  // Calculate actual weight
  let actualWeight;
  if (Array.isArray(shipment_details) && shipment_details.length > 0) {
    actualWeight = shipment_details.reduce(
      (sum, b) => sum + (b.weight || 0) * (b.count || 0),
      0
    );
  } else {
    actualWeight = (weight || 0) * (noofboxes || 0);
  }

  const hasLegacy =
    noofboxes !== undefined &&
    length !== undefined &&
    width !== undefined &&
    height !== undefined &&
    weight !== undefined;

  // Validate required fields
  if (
    !customerID ||
    !userogpincode ||
    !modeoftransport ||
    !fromPincode ||
    !toPincode ||
    (!(Array.isArray(shipment_details) && shipment_details.length > 0) && !hasLegacy)
  ) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields. Provide shipment_details or legacy weight/box parameters.",
    });
  }

  // Calculate distance
  const distData = await calculateDistanceBetweenPincode(fromPincode, toPincode);
  const estTime = distData.estTime;
  const dist = distData.distance;

  // Canonical values for DB vs lookups
  const fromPinNum = Number(fromPincode);
  const toPinNum = Number(toPincode);
  const fromPinStr = String(fromPincode).trim();
  const toPinStr = String(toPincode).trim();

  try {
    // Fetch tied-up companies (including zoneConfig for vendor-specific zone lookup)
    console.time(`[${rid}] DB tiedUpCompanies`);
    const tiedUpCompanies = await temporaryTransporterModel
      .find({ customerID })
      .select("customerID companyName prices selectedZones zoneConfig invoice_rule invoiceRule invoiceValueCharges")
      .lean()
      .maxTimeMS(20000);
    console.timeEnd(`[${rid}] DB tiedUpCompanies`);
    console.log(`[${rid}] tiedUpCompanies: ${tiedUpCompanies.length}`);

    // Fetch customer data
    console.time(`[${rid}] DB customer`);
    const customerData = await customerModel
      .findById(customerID)
      .select("isSubscribed")
      .lean()
      .maxTimeMS(15000);
    console.timeEnd(`[${rid}] DB customer`);

    if (!customerData) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }
    const isSubscribed = !!customerData.isSubscribed;

    // Global zone validation (for initial sanity check)
    const fromZoneRaw = zoneForPincode(fromPinStr);
    const toZoneRaw = zoneForPincode(toPinStr);
    const fromZone = fromZoneRaw ? String(fromZoneRaw).trim().toUpperCase() : null;
    const toZone = toZoneRaw ? String(toZoneRaw).trim().toUpperCase() : null;

    if (!fromZone || !toZone) {
      console.log(
        `[${rid}] Invalid zones: fromZone=${fromZoneRaw}(${fromZone}), toZone=${toZoneRaw}(${toZone}), fromPinStr=${fromPinStr}, toPinStr=${toPinStr}`
      );
      return res.status(400).json({
        success: false,
        message: "Invalid pincodes - could not determine zones",
      });
    }

    // Fetch transporters
    console.time(`[${rid}] DB transporters`);
    const transporterData = await transporterModel
      .aggregate([
        {
          $match: {
            service: {
              $all: [
                { $elemMatch: { pincode: fromPinNum } },
                { $elemMatch: { pincode: toPinNum } },
              ],
            },
            servicableZones: { $all: [fromZone, toZone] },
          },
        },
        {
          $project: {
            companyName: 1,
            servicableZones: 1,
            service: {
              $filter: {
                input: "$service",
                as: "s",
                cond: {
                  $or: [
                    { $eq: ["$$s.pincode", fromPinNum] },
                    { $eq: ["$$s.pincode", toPinNum] },
                  ],
                },
              },
            },
          },
        },
      ])
      .allowDiskUse(true)
      .exec();
    console.timeEnd(`[${rid}] DB transporters`);
    console.log(`[${rid}] candidate transporters: ${transporterData.length}`);

    let l1 = Number.MAX_SAFE_INTEGER;

    // ========================================================================
    // BUILD TIED-UP RESULTS (with vendor-specific zones)
    // ========================================================================
    console.time(`[${rid}] BUILD tiedUpResult`);
    const tiedUpRaw = await Promise.all(
      tiedUpCompanies.map(async (tuc) => {
        try {
          const companyName = tuc.companyName;
          if (!companyName) return null;

          const priceChart = tuc.prices?.priceChart;
          if (!priceChart || !Object.keys(priceChart).length) return null;

          // ✅ Use vendor-specific zone lookup from zoneConfig
          const vendorId = tuc._id;
          const vendorZoneConfig = tuc.zoneConfig || {};
          
          // Use vendor's zoneConfig for zone lookup
          const originZoneData = await getZoneForPincode(vendorId, fromPincode, vendorZoneConfig);
          const destZoneData = await getZoneForPincode(vendorId, toPincode, vendorZoneConfig);

          // ✅ STRICT MODE: For temporary transporters with zoneConfig,
          // BOTH pincodes must be explicitly mapped in vendor's zoneConfig
          // If either pincode falls back to global, skip this vendor
          const hasZoneConfig = Object.keys(vendorZoneConfig).length > 0;
          if (hasZoneConfig) {
            if (originZoneData?.source !== 'vendor' || destZoneData?.source !== 'vendor') {
              console.log(
                `[${rid}] STRICT: ${companyName} skipped - pincodes not in vendor zoneConfig (origin=${originZoneData?.source}, dest=${destZoneData?.source})`
              );
              return null;
            }
          }

          const originZone = originZoneData?.zone;
          const destZone = destZoneData?.zone;
          const destIsOda = !!destZoneData?.isOda;

          console.log(
            `[${rid}] Zones for ${companyName}: Origin=${originZone} (${originZoneData?.source}), Dest=${destZone} (${destZoneData?.source})`
          );

          if (!originZone || !destZone) {
            console.log(`[${rid}] Invalid zones for ${companyName}, skipping`);
            return null;
          }

          // Respect vendor's selectedZones (if any)
          const relSelected = Array.isArray(tuc.selectedZones)
            ? tuc.selectedZones.map((z) => String(z).toUpperCase())
            : [];
          if (
            relSelected.length > 0 &&
            (!relSelected.includes(String(originZone).toUpperCase()) ||
              !relSelected.includes(String(destZone).toUpperCase()))
          ) {
            console.log(
              `[${rid}] Vendor ${companyName} does not serve origin/dest zones, skipping`
            );
            return null;
          }

          const unitPriceRaw = getUnitPriceFromPriceChart(priceChart, originZone, destZone);
// coerce to number safely (handles strings like "0" or "0.00")
const unitPrice = unitPriceRaw == null ? null : Number(unitPriceRaw);

// Reject if missing, NaN or <= 0 for this origin->dest zone
if (unitPrice == null || !Number.isFinite(unitPrice) || unitPrice <= 0) {
  console.log(
    `[${rid}] Invalid/zero price for ${originZone}->${destZone} in ${companyName} (raw=${unitPriceRaw}), skipping`
  );
  return null;
}


          const pr = tuc.prices?.priceRate || {};
          const kFactor = pr.kFactor ?? pr.divisor ?? 5000;

          // Volumetric weight calculation
          let volumetricWeight = 0;
          if (Array.isArray(shipment_details) && shipment_details.length > 0) {
            volumetricWeight = shipment_details.reduce((sum, item) => {
              const cnt = Number(item.count || 0);
              const l = Number(item.length || 0);
              const w = Number(item.width || 0);
              const h = Number(item.height || 0);
              const vol = (l * w * h * cnt) / kFactor;
              return sum + Math.ceil(vol || 0);
            }, 0);
          } else {
            const volLegacy =
              ((Number(length || 0) *
                Number(width || 0) *
                Number(height || 0) *
                Number(noofboxes || 0)) /
                kFactor) || 0;
            volumetricWeight = Math.ceil(volLegacy || 0);
          }

          const actualW = Number(actualWeight || 0);
          const chargeableWeight = Math.max(volumetricWeight, actualW);
          const baseFreight = unitPrice * chargeableWeight;

          // Calculate all charges
          const docketCharge = Number(pr.docketCharges || 0);
          const minCharges = Number(pr.minCharges || 0);
          const greenTax = Number(pr.greenTax || 0);
          const daccCharges = Number(pr.daccCharges || 0);
          const miscCharges = Number(pr.miscellanousCharges || 0);
          const fuelCharges = (Number(pr.fuel || 0) / 100) * baseFreight;
          const rovCharges = Math.max(
            (Number(pr.rovCharges?.variable || 0) / 100) * baseFreight,
            Number(pr.rovCharges?.fixed || 0)
          );
          const insuaranceCharges = Math.max(
            (Number(pr.insuaranceCharges?.variable || 0) / 100) * baseFreight,
            Number(pr.insuaranceCharges?.fixed || 0)
          );

          const odaCharges = destIsOda
            ? Number(pr.odaCharges?.fixed || 0) +
              chargeableWeight * (Number(pr.odaCharges?.variable || 0) / 100)
            : 0;

          const handlingCharges =
            Number(pr.handlingCharges?.fixed || 0) +
            chargeableWeight * (Number(pr.handlingCharges?.variable || 0) / 100);

          const fmCharges = Math.max(
            (Number(pr.fmCharges?.variable || 0) / 100) * baseFreight,
            Number(pr.fmCharges?.fixed || 0)
          );

          const appointmentCharges = Math.max(
            (Number(pr.appointmentCharges?.variable || 0) / 100) * baseFreight,
            Number(pr.appointmentCharges?.fixed || 0)
          );

          const totalChargesBeforeAddon =
            baseFreight +
            docketCharge +
            minCharges +
            greenTax +
            daccCharges +
            miscCharges +
            fuelCharges +
            rovCharges +
            insuaranceCharges +
            odaCharges +
            handlingCharges +
            fmCharges +
            appointmentCharges;

          l1 = Math.min(l1, totalChargesBeforeAddon);

          const invoiceAddon = calculateInvoiceValueCharge(
            invoiceValue,
            tuc.invoiceValueCharges || {}
          );

          return {
            companyId: tuc._id,
            companyName,
            originPincode: fromPincode,
            destinationPincode: toPincode,
            originZone,
            destZone,
            zoneSource: `${originZoneData?.source || "unknown"}/${destZoneData?.source || "unknown"}`,
            estimatedTime: estTime,
            distance: dist,
            actualWeight: parseFloat(actualW.toFixed(2)),
            volumetricWeight: parseFloat(volumetricWeight.toFixed(2)),
            chargeableWeight: parseFloat(chargeableWeight.toFixed(2)),
            unitPrice,
            baseFreight,
            docketCharge,
            minCharges,
            greenTax,
            daccCharges,
            miscCharges,
            fuelCharges,
            rovCharges,
            insuaranceCharges,
            odaCharges,
            handlingCharges,
            fmCharges,
            appointmentCharges,
            invoiceValue,
            invoiceAddon: Math.round(invoiceAddon || 0),
            invoiceValueCharge: Math.round(invoiceAddon || 0),
            totalCharges: Math.round(totalChargesBeforeAddon + (invoiceAddon || 0)),
            totalChargesWithoutInvoiceAddon: Math.round(totalChargesBeforeAddon),
            isHidden: false,
          };
        } catch (err) {
          console.warn(
            `[${rid}] Error computing tiedUp vendor ${tuc?._id || "unknown"}:`,
            err?.message || err
          );
          return null;
        }
      })
    );

    // ✅ FIX #2: Single declaration of tiedUpResult (removed duplicate)
    const tiedUpResult = tiedUpRaw.filter(Boolean);
    console.timeEnd(`[${rid}] BUILD tiedUpResult`);
    console.log(`[${rid}] tiedUpResult count: ${tiedUpResult.length}`);

    // ========================================================================
    // FETCH TEMPORARY TRANSPORTERS
    // ========================================================================
    console.time(`[${rid}] DB temporaryTransporters`);
    const temporaryTransporters = await temporaryTransporterModel
      .find({ customerID })
      .select("customerID companyName vendorCode prices selectedZones zoneConfig invoice_rule invoiceRule invoiceValueCharges")
      .lean()
      .maxTimeMS(20000);
    console.timeEnd(`[${rid}] DB temporaryTransporters`);
    console.log(`[${rid}] temporaryTransporters: ${temporaryTransporters.length}`);

    // ========================================================================
    // BUILD TEMPORARY TRANSPORTER RESULTS (with vendor-specific zones)
    // ========================================================================
    console.time(`[${rid}] BUILD temporaryTransporterResult`);
    const temporaryTransporterRaw = await Promise.all(
      temporaryTransporters.map(async (tempTransporter) => {
        try {
          const priceChart = tempTransporter.prices?.priceChart;
          if (!priceChart || !Object.keys(priceChart).length) return null;

          // ✅ Use vendor-specific zone lookup from zoneConfig
          const vendorId = tempTransporter._id;
          const vendorZoneConfig = tempTransporter.zoneConfig || {};
          
          const originZoneData = await getZoneForPincode(vendorId, fromPincode, vendorZoneConfig);
          const destZoneData = await getZoneForPincode(vendorId, toPincode, vendorZoneConfig);

          // ✅ STRICT MODE: For temporary transporters with zoneConfig,
          // BOTH pincodes must be explicitly mapped in vendor's zoneConfig
          // If either pincode falls back to global, skip this vendor
          const hasZoneConfig = Object.keys(vendorZoneConfig).length > 0;
          if (hasZoneConfig) {
            if (originZoneData?.source !== 'vendor' || destZoneData?.source !== 'vendor') {
              console.log(
                `[${rid}] STRICT: ${tempTransporter.companyName} skipped - pincodes not in vendor zoneConfig (origin=${originZoneData?.source}, dest=${destZoneData?.source})`
              );
              return null;
            }
          }

          const originZone = originZoneData?.zone;
          const destZone = destZoneData?.zone;
          const destIsOda = destZoneData?.isOda || false;

          console.log(
            `[${rid}] Zones for ${tempTransporter.companyName}: Origin=${originZone} (${originZoneData?.source}), Dest=${destZone} (${destZoneData?.source})`
          );

          if (!originZone || !destZone) {
            console.log(`[${rid}] Invalid zones for temp transporter, skipping`);
            return null;
          }

          // Check if vendor serves these zones
          const selectedZones = (tempTransporter.selectedZones || []).map((z) =>
            String(z).toUpperCase()
          );
          if (
            selectedZones.length > 0 &&
            (!selectedZones.includes(originZone) || !selectedZones.includes(destZone))
          ) {
            console.log(`[${rid}] Temp transporter does not serve these zones, skipping`);
            return null;
          }
// ---------- Defensive unitPrice + volumetric-weight block (drop-in) ----------

// helper: safe number coercion
function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// safe extraction of unit price (handles string numbers, nulls, NaN)
const unitPriceRaw = getUnitPriceFromPriceChart(priceChart, originZone, destZone);
const unitPrice = unitPriceRaw == null ? null : Number(unitPriceRaw);

// Reject vendor for this route if price is missing, non-numeric or <= 0
if (unitPrice == null || !Number.isFinite(unitPrice) || unitPrice <= 0) {
  console.log(
    `[${rid}] Invalid/zero price for ${originZone}->${destZone} in ${tempTransporter.companyName} (raw=${unitPriceRaw}), skipping`
  );
  return null;
}

// pricing / k-factor
const pr = tempTransporter.prices.priceRate || {};
const kFactorRaw = pr.kFactor ?? pr.divisor ?? 5000;
const kFactor = toNum(kFactorRaw, 5000);

// invalid kFactor -> skip vendor (prevents divide-by-zero/Infinity)
if (kFactor <= 0) {
  console.log(`[${rid}] Invalid kFactor (${kFactorRaw}) for ${tempTransporter.companyName}, skipping`);
  return null;
}

// compute volumetric weight defensively
let volumetricWeight = 0;

if (Array.isArray(shipment_details) && shipment_details.length > 0) {
  for (const item of shipment_details) {
    const l = toNum(item.length, 0);
    const w = toNum(item.width, 0);
    const h = toNum(item.height, 0);
    // treat missing/zero counts as 1 (preserves legacy behaviour)
    const cnt = Math.max(1, Math.floor(toNum(item.count, 1)));

    const vol = (l * w * h * cnt) / kFactor;
    if (!Number.isFinite(vol)) {
      console.log(`[${rid}] Non-finite volumetric calculation for ${tempTransporter.companyName}, skipping`);
      return null;
    }
    volumetricWeight += Math.ceil(Math.max(0, vol));
  }
} else {
  const l = toNum(length, 0);
  const w = toNum(width, 0);
  const h = toNum(height, 0);
  const cnt = Math.max(1, Math.floor(toNum(noofboxes, 1)));

  const volLegacy = (l * w * h * cnt) / kFactor;
  if (!Number.isFinite(volLegacy)) {
    console.log(`[${rid}] Non-finite legacy volumetric calculation for ${tempTransporter.companyName}, skipping`);
    return null;
  }
  volumetricWeight = Math.ceil(Math.max(0, volLegacy));
}

// ensure actualWeight is numeric
const actualWeightNum = toNum(actualWeight, 0);

// ensure minWeight if present
const minWeight = toNum(pr.minWeight, 0);

// final chargeable weight: use max of volumetric, actual, minWeight
const chargeableWeight = Math.max(minWeight, actualWeightNum, volumetricWeight);

// guard against weird results (Infinity, NaN, zero)
if (!Number.isFinite(chargeableWeight) || chargeableWeight <= 0) {
  console.log(`[${rid}] Invalid chargeableWeight=${chargeableWeight} for ${tempTransporter.companyName}, skipping`);
  return null;
}

const baseFreight = unitPrice * chargeableWeight;


          // Calculate all charges
          const docketCharge = pr.docketCharges || 0;
          const minCharges = pr.minCharges || 0;
          const greenTax = pr.greenTax || 0;
          const daccCharges = pr.daccCharges || 0;
          const miscCharges = pr.miscellanousCharges || 0;
          const fuelCharges = ((pr.fuel || 0) / 100) * baseFreight;
          const rovCharges = Math.max(
            ((pr.rovCharges?.variable || 0) / 100) * baseFreight,
            pr.rovCharges?.fixed || 0
          );
          const insuaranceCharges = Math.max(
            ((pr.insuaranceCharges?.variable || 0) / 100) * baseFreight,
            pr.insuaranceCharges?.fixed || 0
          );

          // ✅ Use destIsOda from vendor-specific lookup
          const odaCharges = destIsOda
            ? (pr.odaCharges?.fixed || 0) +
              chargeableWeight * ((pr.odaCharges?.variable || 0) / 100)
            : 0;

          const handlingCharges =
            (pr.handlingCharges?.fixed || 0) +
            chargeableWeight * ((pr.handlingCharges?.variable || 0) / 100);
          const fmCharges = Math.max(
            ((pr.fmCharges?.variable || 0) / 100) * baseFreight,
            pr.fmCharges?.fixed || 0
          );
          const appointmentCharges = Math.max(
            ((pr.appointmentCharges?.variable || 0) / 100) * baseFreight,
            pr.appointmentCharges?.fixed || 0
          );

          const totalChargesBeforeAddon =
            baseFreight +
            docketCharge +
            minCharges +
            greenTax +
            daccCharges +
            miscCharges +
            fuelCharges +
            rovCharges +
            insuaranceCharges +
            odaCharges +
            handlingCharges +
            fmCharges +
            appointmentCharges;

          const invoiceAddon = calculateInvoiceValueCharge(
            invoiceValue,
            tempTransporter.invoiceValueCharges
          );
          console.log(
  `[${rid}] QUOTE READY ${tempTransporter.companyName} raw=${unitPriceRaw} unitPrice=${unitPrice} chargeableWeight=${chargeableWeight} baseFreight=${baseFreight} totalBeforeInvoice=${totalChargesBeforeAddon} invoiceAddon=${invoiceAddon || 0} total=${Math.round(totalChargesBeforeAddon + (invoiceAddon || 0))}`
);

          return {
            companyId: tempTransporter._id,
            companyName: tempTransporter.companyName,
            vendorCode: tempTransporter.vendorCode,
            originPincode: fromPincode,
            destinationPincode: toPincode,
            originZone,
            destZone,
            zoneSource: `${originZoneData?.source}/${destZoneData?.source}`,
            estimatedTime: estTime,
            distance: dist,
            actualWeight: parseFloat(actualWeight.toFixed(2)),
            volumetricWeight: parseFloat(volumetricWeight.toFixed(2)),
            chargeableWeight: parseFloat(chargeableWeight.toFixed(2)),
            unitPrice,
            baseFreight,
            docketCharge,
            minCharges,
            greenTax,
            daccCharges,
            miscCharges,
            fuelCharges,
            rovCharges,
            insuaranceCharges,
            odaCharges,
            handlingCharges,
            fmCharges,
            appointmentCharges,
            totalCharges: Math.round(totalChargesBeforeAddon + invoiceAddon),
            totalChargesWithoutInvoiceAddon: Math.round(totalChargesBeforeAddon),
            invoiceAddon: Math.round(invoiceAddon),
            invoiceValueCharge: Math.round(invoiceAddon),
            isHidden: false,
            isTemporaryTransporter: true,
          };
        } catch (err) {
          console.warn(
            `[${rid}] Error computing temp transporter:`,
            err?.message || err
          );
          return null;
        }
      })
    );
    const temporaryTransporterResult = temporaryTransporterRaw.filter(Boolean);
    console.timeEnd(`[${rid}] BUILD temporaryTransporterResult`);
    console.log(`[${rid}] temporaryTransporterResult count: ${temporaryTransporterResult.length}`);

    // ========================================================================
    // BUILD PUBLIC TRANSPORTER RESULTS
    // ========================================================================
    console.time(`[${rid}] BUILD transporterResult`);
    const transporterRaw = await Promise.all(
      transporterData.map(async (data) => {
        console.log(`\n--- [CHECKING] Transporter: ${data.companyName} ---`);

        const matchedOrigin = data.service?.find(
          (entry) =>
            String(entry.pincode).trim() === fromPinStr ||
            Number(entry.pincode) === fromPinNum
        );
        if (!matchedOrigin || matchedOrigin.isOda) {
          console.log(
            `-> [REJECTED] Reason: Origin pincode ${fromPincode} is not serviceable or is ODA.`
          );
          return null;
        }

        const matchedDest = data.service?.find(
          (entry) =>
            String(entry.pincode).trim() === toPinStr ||
            Number(entry.pincode) === toPinNum
        );
        if (!matchedDest) {
          console.log(
            `-> [REJECTED] Reason: Destination pincode ${toPincode} is not serviceable.`
          );
          return null;
        }

        const originZone = matchedOrigin.zone;
        const destZone = matchedDest.zone;
        const destOda = matchedDest.isOda;

        console.time(`[${rid}] DB priceModel ${data._id}`);
        const priceData = await priceModel
          .findOne({ companyId: data._id })
          .select("priceRate zoneRates invoiceValueCharges")
          .lean()
          .maxTimeMS(15000);
        console.timeEnd(`[${rid}] DB priceModel ${data._id}`);

        if (!priceData) {
          console.log(
            `-> [REJECTED] Reason: No price document found in the database.`
          );
          return null;
        }

        const pr = priceData.priceRate || {};
        const unitPrice = getUnitPriceFromPriceChart(
          priceData.zoneRates,
          originZone,
          destZone
        );
        if (!unitPrice) {
          console.log(
            `-> [REJECTED] Reason: No unit price found for route between zone ${originZone} and ${destZone}.`
          );
          return null;
        }

        const kFactor = pr.kFactor ?? pr.divisor ?? 5000;

        let volumetricWeight = 0;
        if (Array.isArray(shipment_details) && shipment_details.length > 0) {
          volumetricWeight = shipment_details.reduce((sum, item) => {
            const volWeightForItem =
              ((item.length || 0) *
                (item.width || 0) *
                (item.height || 0) *
                (item.count || 0)) /
              kFactor;
            return sum + Math.ceil(volWeightForItem);
          }, 0);
        } else {
          const volWeightForLegacy =
            ((length || 0) * (width || 0) * (height || 0) * (noofboxes || 0)) /
            kFactor;
          volumetricWeight = Math.ceil(volWeightForLegacy);
        }

        const chargeableWeight = Math.max(volumetricWeight, actualWeight);
        const baseFreight = unitPrice * chargeableWeight;
        const docketCharge = pr.docketCharges || 0;
        const minCharges = pr.minCharges || 0;
        const greenTax = pr.greenTax || 0;
        const daccCharges = pr.daccCharges || 0;
        const miscCharges = pr.miscellanousCharges || 0;
        const fuelCharges = ((pr.fuel || 0) / 100) * baseFreight;
        const rovCharges = Math.max(
          ((pr.rovCharges?.variable || 0) / 100) * baseFreight,
          pr.rovCharges?.fixed || 0
        );
        const insuaranceCharges = Math.max(
          ((pr.insuaranceCharges?.variable || 0) / 100) * baseFreight,
          pr.insuaranceCharges?.fixed || 0
        );
        const odaCharges = destOda
          ? (pr.odaCharges?.fixed || 0) +
            chargeableWeight * ((pr.odaCharges?.variable || 0) / 100)
          : 0;
        const handlingCharges =
          (pr.handlingCharges?.fixed || 0) +
          chargeableWeight * ((pr.handlingCharges?.variable || 0) / 100);
        const fmCharges = Math.max(
          ((pr.fmCharges?.variable || 0) / 100) * baseFreight,
          pr.fmCharges?.fixed || 0
        );
        const appointmentCharges = Math.max(
          ((pr.appointmentCharges?.variable || 0) / 100) * baseFreight,
          pr.appointmentCharges?.fixed || 0
        );

        const totalChargesBeforeAddon =
          baseFreight +
          docketCharge +
          minCharges +
          greenTax +
          daccCharges +
          miscCharges +
          fuelCharges +
          rovCharges +
          insuaranceCharges +
          odaCharges +
          handlingCharges +
          fmCharges +
          appointmentCharges;

        console.log(
          `-> [SUCCESS] Quote calculated. Chargeable Weight: ${chargeableWeight.toFixed(
            2
          )}kg, Total: ${totalChargesBeforeAddon.toFixed(2)}`
        );

        if (l1 < totalChargesBeforeAddon) return null;

        // Calculate Invoice Charges
        const invoiceAddon = calculateInvoiceValueCharge(
          invoiceValue,
          priceData.invoiceValueCharges || {}
        );

        if (!isSubscribed) {
          // Return hidden quote with charges
          return {
            totalCharges: Math.round(totalChargesBeforeAddon + invoiceAddon),
            totalChargesWithoutInvoiceAddon: Math.round(totalChargesBeforeAddon),
            invoiceAddon: Math.round(invoiceAddon),
            invoiceValueCharge: Math.round(invoiceAddon),
            isHidden: true,
          };
        }

        console.log(
          `[${rid}] PublicTransporter: invoiceValue=${invoiceValue}, invoiceAddon=${invoiceAddon}`
        );

        return {
          companyId: data._id,
          companyName: data.companyName,
          originPincode: fromPincode,
          destinationPincode: toPincode,
          estimatedTime: estTime,
          distance: dist,
          actualWeight: parseFloat(actualWeight.toFixed(2)),
          volumetricWeight: parseFloat(volumetricWeight.toFixed(2)),
          chargeableWeight: parseFloat(chargeableWeight.toFixed(2)),
          unitPrice,
          baseFreight,
          docketCharge,
          minCharges,
          greenTax,
          daccCharges,
          miscCharges,
          fuelCharges,
          rovCharges,
          insuaranceCharges,
          odaCharges,
          handlingCharges,
          fmCharges,
          appointmentCharges,
          totalCharges: Math.round(totalChargesBeforeAddon + invoiceAddon),
          totalChargesWithoutInvoiceAddon: Math.round(totalChargesBeforeAddon),
          invoiceAddon: Math.round(invoiceAddon),
          invoiceValueCharge: Math.round(invoiceAddon),
          isHidden: false,
        };
      })
    );
    const transporterResult = transporterRaw.filter(Boolean);
    console.timeEnd(`[${rid}] BUILD transporterResult`);
    console.log(`[${rid}] transporterResult count: ${transporterResult.length}`);

    // Combine all tied-up results
    const allTiedUpResults = [...tiedUpResult, ...temporaryTransporterResult];

    return res.status(200).json({
      success: true,
      message: "Price calculated successfully",
      tiedUpResult: allTiedUpResults,
      companyResult: transporterResult,
    });
  } catch (err) {
    console.error("An error occurred in calculatePrice:", err);
    return res.status(500).json({
      success: false,
      message: "An internal server error occurred.",
    });
  }
};

export const addTiedUpCompany = async (req, res) => {
  try {
    let {
      customerID,
      vendorCode,
      vendorPhone,
      vendorEmail,
      gstNo,
      mode,
      address,
      state,
      city,
      pincode,
      rating,
      companyName,
      contactPerson,
      subVendor,
      priceRate,
      priceChart,
      selectedZones,
      vendorJson,
      invoiceValueCharges,
      // NEW: Zone configurations with city/pincode mappings
      zoneConfigurations,
    } = req.body;

    // Debug: Log received values to verify they're coming through
    console.log('📥 Received vendor data:', {
      companyName,
      contactPerson: contactPerson || '(empty)',
      subVendor: subVendor || '(empty)',
      hasPriceRate: !!priceRate,
      priceRateKeys: priceRate ? Object.keys(priceRate) : [],
      codChargesReceived: priceRate?.codCharges ? {
        fixed: priceRate.codCharges.fixed,
        variable: priceRate.codCharges.variable,
      } : 'NOT PRESENT',
      topayChargesReceived: priceRate?.topayCharges ? {
        fixed: priceRate.topayCharges.fixed,
        variable: priceRate.topayCharges.variable,
      } : 'NOT PRESENT',
    });

    // Parse JSON strings if they come from FormData
    if (typeof priceRate === "string") {
      try {
        priceRate = JSON.parse(priceRate);
      } catch (e) {
        console.error("Failed to parse priceRate:", e);
      }
    }

    if (typeof priceChart === "string") {
      try {
        priceChart = JSON.parse(priceChart);
      } catch (e) {
        console.error("Failed to parse priceChart:", e);
      }
    }

    if (typeof selectedZones === "string") {
      try {
        selectedZones = JSON.parse(selectedZones);
      } catch (e) {
        console.error("Failed to parse selectedZones:", e);
      }
    }

    // Parse vendorJson if it's a JSON string
    let parsedVendorJson = null;
    if (vendorJson) {
      try {
        parsedVendorJson =
          typeof vendorJson === "string" ? JSON.parse(vendorJson) : vendorJson;
      } catch (e) {
        console.error("Failed to parse vendorJson:", e);
      }
    }

    // Build invoiceValueCharges from either vendorJson or direct body
    const defaultInvoiceValueCharges = {
      enabled: false,
      percentage: 0,
      minimumAmount: 0,
      description: "Invoice Value Handling Charges",
    };

    const invoiceFromVendorJson =
      parsedVendorJson && parsedVendorJson.invoiceValueCharges
        ? parsedVendorJson.invoiceValueCharges
        : null;

    const invoiceFromBody =
      invoiceValueCharges && typeof invoiceValueCharges === "object"
        ? invoiceValueCharges
        : null;

    const finalInvoiceValueCharges = {
      ...defaultInvoiceValueCharges,
      ...(invoiceFromVendorJson || {}),
      ...(invoiceFromBody || {}),
    };

    // Basic required field validation
    if (
      !customerID ||
      !vendorCode ||
      !vendorPhone ||
      !vendorEmail ||
      !gstNo ||
      !mode ||
      !address ||
      !state ||
      !pincode ||
      !rating ||
      !companyName ||
      !priceRate ||
      !priceChart
    ) {
      return res.status(400).json({
        success: false,
        message:
          "customerID, companyName, priceRate and priceChart are all required",
      });
    }

    // Enhanced companyName validation
    if (!companyName || typeof companyName !== 'string' || companyName.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Company name must be at least 2 characters",
      });
    }

    // Input validation and sanitization
    const validationErrors = [];

    if (!validateEmail(vendorEmail)) {
      validationErrors.push("Invalid email format");
    }

    if (!validatePhone(vendorPhone)) {
      validationErrors.push(
        "Invalid phone number format (must be 10 digits, cannot start with 0)"
      );
    }

    if (!validateGSTIN(gstNo)) {
      validationErrors.push("Invalid GSTIN format");
    }

    if (!validatePincode(pincode)) {
      validationErrors.push("Invalid pincode format (must be 6 digits)");
    }

    if (
      selectedZones &&
      Array.isArray(selectedZones) &&
      selectedZones.length > 0
    ) {
      const sanitizedZones = sanitizeZoneCodes(selectedZones);
      const matrixValidation = validateZoneMatrix(priceChart, sanitizedZones);

      if (!matrixValidation.valid) {
        validationErrors.push(...matrixValidation.errors);
      }
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validationErrors,
      });
    }

    // Sanitize inputs
    const sanitizedCompanyName = sanitizeString(companyName, 100);
    const sanitizedContactPerson = contactPerson ? sanitizeString(contactPerson, 50) : "";
    const sanitizedAddress = sanitizeString(address, 200);
    const sanitizedState = sanitizeString(state, 50);
    const sanitizedCity = city ? sanitizeString(city, 50) : "";
    const sanitizedSubVendor = subVendor ? sanitizeString(subVendor, 50) : "";
    const sanitizedZones = selectedZones ? sanitizeZoneCodes(selectedZones) : [];

    // Check duplicate temp vendor
    const existingTempVendor = await temporaryTransporterModel.findOne({
      customerID: customerID,
      companyName: sanitizedCompanyName,
      vendorCode: vendorCode,
    });

    if (existingTempVendor) {
      return res.status(400).json({
        success: false,
        message: "This vendor already exists for your account",
      });
    }

    // =====================================================
    // BUILD ZONE CONFIG (compact format: { N1: ["201301","201302"], N2: [...] })
    // =====================================================
    // Parse zoneConfigurations if it's a string
    let zoneConfigsParsed = null;
    if (zoneConfigurations) {
      try {
        zoneConfigsParsed = typeof zoneConfigurations === 'string' 
          ? JSON.parse(zoneConfigurations) 
          : zoneConfigurations;
      } catch (e) {
        console.error("Failed to parse zoneConfigurations:", e);
      }
    }
    
    // Also try to extract from vendorJson if zoneConfigurations not provided
    if (!zoneConfigsParsed && parsedVendorJson?.zones) {
      zoneConfigsParsed = parsedVendorJson.zones;
    }
    
    // Build compact zoneConfig object: { N1: ["201301","201302"], N2: [...] }
    const zoneConfig = {};
    
    if (zoneConfigsParsed && Array.isArray(zoneConfigsParsed) && zoneConfigsParsed.length > 0) {
      console.log(`[ZoneConfig] Processing ${zoneConfigsParsed.length} zone configs`);
      
      // Use pre-loaded pincodes data (loaded at startup)
      const pincodes = pincodeDataArray;
      
      // Build city+state -> pincodes lookup (case-insensitive)
      const cityStateToPincodes = {};
      for (const entry of pincodes) {
        const key = `${String(entry.city || '').trim().toUpperCase()}||${String(entry.state || '').trim().toUpperCase()}`;
        if (!cityStateToPincodes[key]) {
          cityStateToPincodes[key] = [];
        }
        cityStateToPincodes[key].push(String(entry.pincode));
      }
      
      // Process each zone config
      for (const zc of zoneConfigsParsed) {
        const zoneCode = (zc.zoneCode || zc.zone || '').toString().trim().toUpperCase();
        const selectedCities = zc.selectedCities || zc.cities || [];
        
        if (!zoneCode || !Array.isArray(selectedCities)) {
          console.warn(`[ZoneConfig] Skipping invalid zone config:`, zc);
          continue;
        }
        
        // Initialize zone array if not exists
        if (!zoneConfig[zoneCode]) {
          zoneConfig[zoneCode] = [];
        }
        
        // Add all pincodes for each selected city to this zone
        for (const cityKey of selectedCities) {
          const normalizedKey = String(cityKey || '').trim().toUpperCase();
          const pincodesForCity = cityStateToPincodes[normalizedKey] || [];
          
          if (pincodesForCity.length === 0) {
            console.warn(`[ZoneConfig] No pincodes found for city key: ${cityKey}`);
            continue;
          }
          
          // Add pincodes to zone (avoiding duplicates)
          for (const pc of pincodesForCity) {
            if (!zoneConfig[zoneCode].includes(pc)) {
              zoneConfig[zoneCode].push(pc);
            }
          }
        }
        
        console.log(`[ZoneConfig] Zone ${zoneCode}: ${zoneConfig[zoneCode].length} pincodes`);
      }
      
      const totalPincodes = Object.values(zoneConfig).reduce((sum, arr) => sum + arr.length, 0);
      console.log(`[ZoneConfig] Total: ${Object.keys(zoneConfig).length} zones, ${totalPincodes} pincodes`);
    } else {
      console.log(`[ZoneConfig] No zoneConfigurations provided`);
    }

    // Debug: Log what we're about to save
    console.log('💾 Saving to DB:', {
      companyName: sanitizedCompanyName,
      contactPerson: sanitizedContactPerson || '(empty)',
      subVendor: sanitizedSubVendor || '(empty)',
      codCharges: priceRate?.codCharges || 'NOT IN PRICERATE',
      topayCharges: priceRate?.topayCharges || 'NOT IN PRICERATE',
      rovCharges: priceRate?.rovCharges || 'NOT IN PRICERATE',
      prepaidCharges: priceRate?.prepaidCharges || 'NOT IN PRICERATE',
      fullPriceRate: priceRate ? 'HAS DATA' : 'MISSING',
      zoneConfigZones: Object.keys(zoneConfig),
    });

    const tempData = await new temporaryTransporterModel({
      customerID: customerID,
      companyName: sanitizedCompanyName,
      contactPerson: sanitizedContactPerson,
      vendorCode: vendorCode,
      vendorPhone: Number(vendorPhone),
      vendorEmail: vendorEmail.trim().toLowerCase(),
      gstNo: gstNo.trim().toUpperCase(),
      mode: mode,
      address: sanitizedAddress,
      state: sanitizedState,
      city: sanitizedCity,
      pincode: Number(pincode),
      rating: Number(rating) || 3,
      subVendor: sanitizedSubVendor,
      selectedZones: sanitizedZones,
      zoneConfig: zoneConfig,  // ✅ Compact format: { N1: ["201301",...], N2: [...] }
      prices: {
        priceRate: priceRate,
        priceChart: priceChart,
      },
      invoiceValueCharges: finalInvoiceValueCharges,
    }).save();

    if (tempData) {
      console.log(`[ZoneConfig] Vendor ${tempData._id} saved with ${Object.keys(zoneConfig).length} zones`);
      return res.status(201).json({
        success: true,
        message: "Vendor added successfully to your tied-up vendors",
        data: tempData,
      });
    } else {
      return res.status(500).json({
        success: false,
        message: "Failed to save vendor",
      });
    }
  } catch (err) {
    console.error("Error in addTiedUpCompany:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error:
        process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

export const getTiedUpCompanies = async (req, res) => {
  try {
    const userid = await req.query;
    const data = await usertransporterrelationshipModel.findOne({
      customerID: userid,
    });
    return res.status(200).json({
      success: true,
      message: "Tied up companies fetched successfully",
      data: data,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

export const getTemporaryTransporters = async (req, res) => {
  try {
    const { customerID } = req.query;

    if (!customerID) {
      return res.status(400).json({
        success: false,
        message: "Customer ID is required",
      });
    }

    const temporaryTransporters = await temporaryTransporterModel.find({
      customerID: customerID,
    });

    return res.status(200).json({
      success: true,
      message: "Temporary transporters fetched successfully",
      data: temporaryTransporters,
    });
  } catch (error) {
    console.error("Error fetching temporary transporters:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

export const getTransporters = async (req, res) => {
  try {
    const { search } = req.query;
    if (!search || typeof search !== "string" || !search.trim()) {
      return res.status(400).json([]);
    }
    const regex = new RegExp("^" + search, "i");
    const companies = await transporterModel
      .find({ companyName: { $regex: regex } })
      .limit(10)
      .select("companyName");
    res.json(companies.map((c) => c.companyName));
  } catch (err) {
    console.error("Fetch companies error:", err);
    res.status(500).json([]);
  }
};

export const getAllTransporters = async (req, res) => {
  try {
    const transporters = await transporterModel
      .find()
      .select("-password -servicableZones -service");
    if (transporters.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No transporters found",
      });
    }
    return res.status(200).json({
      success: true,
      message: "Transporters fetched successfully",
      data: transporters,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Remove a tied-up vendor for a specific customer by company name (case-insensitive)
export const removeTiedUpVendor = async (req, res) => {
  try {
    console.log("🗑️ ═══════ DELETE VENDOR REQUEST ═══════");
    console.log("📦 req.body:", JSON.stringify(req.body, null, 2));
    console.log("📥 req.params:", JSON.stringify(req.params, null, 2));
    console.log("📤 req.query:", JSON.stringify(req.query, null, 2));
    console.log(
      "👤 req.user:",
      req.user?._id || req.user?.id || "undefined"
    );
    console.log(
      "👤 req.customer:",
      req.customer?._id || req.customer?.id || "undefined"
    );
    console.log("───────────────────────────────────────");

    // Get data from body (preserve original extraction)
    let { customerID, companyName, vendorId } = req.body || {};

    console.log("📋 Extracted from body:");
    console.log("  - customerID:", customerID);
    console.log("  - companyName:", companyName);
    console.log("  - vendorId:", vendorId);

    // Accept id from URL/query if not present in body
    if (!vendorId) {
      if (req.params && req.params.id) {
        vendorId = req.params.id;
        console.log("ℹ️ vendorId taken from req.params.id:", vendorId);
      } else if (req.query && (req.query.vendorId || req.query.id)) {
        vendorId = req.query.vendorId || req.query.id;
        console.log("ℹ️ vendorId taken from req.query:", vendorId);
      }
    }

    // FALLBACK: Get customerID from auth middleware if not in body
    if (!customerID) {
      customerID =
        req.customer?._id ||
        req.customer?.id ||
        req.user?._id ||
        req.user?.id;

      console.log("⚠️ customerID not in body, using auth middleware:", customerID);
    }

    console.log("───────────────────────────────────────");
    console.log("✅ Final values:");
    console.log("  - customerID:", customerID);
    console.log("  - companyName:", companyName);
    console.log("  - vendorId:", vendorId);
    console.log("═══════════════════════════════════════\n");

    // VALIDATION
    if (!customerID || (!companyName && !vendorId)) {
      console.log("❌ VALIDATION FAILED:");
      console.log("  - Has customerID?", !!customerID);
      console.log("  - Has companyName?", !!companyName);
      console.log("  - Has vendorId?", !!vendorId);

      return res.status(400).json({
        success: false,
        message: "customerID and either companyName or vendorId are required",
        debug:
          process.env.NODE_ENV === "development"
            ? {
                receivedCustomerID: !!customerID,
                receivedCompanyName: !!companyName,
                receivedVendorId: !!vendorId,
              }
            : undefined,
      });
    }

    console.log("✅ Validation passed, proceeding with deletion...");

    let relDeleted = 0;
    let tempDeleted = 0;

    // DELETE BY VENDOR ID (preferred)
    if (vendorId) {
      console.log(`🔍 Attempting to delete vendor by ID: ${vendorId}`);

      const tempRes = await temporaryTransporterModel.deleteOne({
        _id: vendorId,
        customerID: customerID,
      });

      tempDeleted = tempRes?.deletedCount || 0;
      console.log(`  ✓ Deleted ${tempDeleted} temporary transporter(s)`);
    }
    // DELETE BY COMPANY NAME (fallback)
    else if (companyName) {
      console.log(`🔍 Attempting to delete vendor by name: ${companyName}`);

      const nameRegex = new RegExp(`^${companyName}$`, "i");

      // Find transporter by name to remove relationships
      const transporter = await transporterModel
        .findOne({
          companyName: nameRegex,
        })
        .select("_id");

      if (transporter?._id) {
        console.log(`  ✓ Found transporter: ${transporter._id}`);

        const relRes = await usertransporterrelationshipModel.deleteMany({
          customerID,
          transporterId: transporter._id,
        });

        relDeleted = relRes?.deletedCount || 0;
        console.log(`  ✓ Deleted ${relDeleted} relationship(s)`);
      } else {
        console.log(`  ⚠️ No transporter found with name: ${companyName}`);
      }

      // Remove any temporary transporters added for this customer
      const tempRes = await temporaryTransporterModel.deleteMany({
        customerID,
        companyName: nameRegex,
      });

      tempDeleted = tempRes?.deletedCount || 0;
      console.log(`  ✓ Deleted ${tempDeleted} temporary transporter(s)`);
    }

    console.log("📊 Deletion summary:");
    console.log(`  - Relationships deleted: ${relDeleted}`);
    console.log(`  - Temporary transporters deleted: ${tempDeleted}`);
    console.log(`  - Total deleted: ${relDeleted + tempDeleted}`);

    if (tempDeleted > 0 || relDeleted > 0) {
      console.log("✅ Vendor deletion successful\n");

      return res.status(200).json({
        success: true,
        message: "Vendor removed successfully",
        removedRelationships: relDeleted,
        removedTemporary: tempDeleted,
      });
    } else {
      console.log("❌ No vendor found to delete\n");

      return res.status(404).json({
        success: false,
        message: "Vendor not found or already deleted",
      });
    }
  } catch (err) {
    console.error("💥 ERROR in removeTiedUpVendor:", err);
    console.error("Stack trace:", err.stack);

    return res.status(500).json({
      success: false,
      message: "Server error",
      error:
        process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

export const savePckingList = async (req, res) => {
  try {
    const {
      customerId,
      name,
      modeoftransport,
      originPincode,
      destinationPincode,
      noofboxes,
      quantity,
      length,
      width,
      height,
      weight,
    } = req.body;
    if (
      !customerId ||
      !name ||
      !modeoftransport ||
      !originPincode ||
      !destinationPincode ||
      !noofboxes ||
      !length ||
      !width ||
      !height ||
      !weight
    ) {
      return res.status(400).json({
        success: false,
        message: "Please fill all the fields",
      });
    }
    const data = await new packingModel({
      customerId,
      name,
      modeoftransport,
      originPincode,
      destinationPincode,
      noofboxes,
      length,
      width,
      height,
      weight,
    }).save();
    if (data) {
      return res.status(200).json({
        success: true,
        message: "Packing list saved successfully",
      });
    }
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
};

export const getPackingList = async (req, res) => {
  try {
    const { customerId } = req.query;
    const data = await packingModel.find({ customerId });
    if (data) {
      return res.status(200).json({
        success: true,
        message: "Packing list found successfully",
        data: data,
      });
    } else {
      return res.status(404).json({
        success: false,
        message: "Packing list not found",
      });
    }
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
};

export const getTrasnporterDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const details = await transporterModel
      .findOne({ _id: id })
      .select("-password -servicableZones -service");
    if (details) {
      return res.status(200).json({
        success: true,
        data: details,
      });
    }
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success: true,
      message: "Server Error",
    });
  }
};

export const updateVendor = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const customerID = req.customer?._id;

    if (!customerID) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    // Verify vendor belongs to customer
    const vendor = await temporaryTransporterModel.findOne({
      _id: id,
      customerID: customerID,
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found or access denied",
      });
    }

    // Remove fields that shouldn't be updated directly
    delete updateData._id;
    delete updateData.createdAt;
    delete updateData.customerID;
    // ✅ Don't delete prices - allow updating prices

    const updatedVendor = await temporaryTransporterModel.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedVendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Vendor updated successfully",
      data: updatedVendor,
    });
  } catch (error) {
    console.error("Error updating vendor:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while updating vendor",
      error:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * Get zone matrix for a vendor
 * GET /api/transporter/zone-matrix/:vendorId
 */
export const getZoneMatrix = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const customerID = req.customer?._id;

    if (!customerID) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const vendor = await temporaryTransporterModel.findOne({
      _id: vendorId,
      customerID: customerID,
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found or access denied",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Zone matrix retrieved successfully",
      data: {
        vendorId: vendor._id,
        companyName: vendor.companyName,
        priceChart: vendor.prices?.priceChart || {},
        selectedZones: vendor.selectedZones || [],
      },
    });
  } catch (error) {
    console.error("Error retrieving zone matrix:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while retrieving zone matrix",
      error:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * Update zone matrix for a vendor
 * PUT /api/transporter/zone-matrix/:vendorId
 */
export const updateZoneMatrix = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { priceChart, selectedZones } = req.body;
    const customerID = req.customer?._id;

    if (!customerID) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!priceChart) {
      return res.status(400).json({
        success: false,
        message: "priceChart is required",
      });
    }

    // Verify vendor belongs to customer
    const vendor = await temporaryTransporterModel.findOne({
      _id: vendorId,
      customerID: customerID,
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found or access denied",
      });
    }

    // Validate zone matrix if selectedZones provided
    const validationErrors = [];
    if (
      selectedZones &&
      Array.isArray(selectedZones) &&
      selectedZones.length > 0
    ) {
      const sanitizedZones = sanitizeZoneCodes(selectedZones);
      const matrixValidation = validateZoneMatrix(priceChart, sanitizedZones);

      if (!matrixValidation.valid) {
        validationErrors.push(...matrixValidation.errors);
      }
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validationErrors,
      });
    }

    // Update zone matrix
    const sanitizedZones = selectedZones
      ? sanitizeZoneCodes(selectedZones)
      : vendor.selectedZones;

    const updatedVendor = await temporaryTransporterModel.findByIdAndUpdate(
      vendorId,
      {
        "prices.priceChart": priceChart,
        selectedZones: sanitizedZones,
      },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Zone matrix updated successfully",
      data: {
        vendorId: updatedVendor._id,
        companyName: updatedVendor.companyName,
        priceChart: updatedVendor.prices.priceChart,
        selectedZones: updatedVendor.selectedZones,
      },
    });
  } catch (error) {
    console.error("Error updating zone matrix:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while updating zone matrix",
      error:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * Delete zone matrix for a vendor (resets to empty)
 * DELETE /api/transporter/zone-matrix/:vendorId
 */
export const deleteZoneMatrix = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const customerID = req.customer?._id;

    if (!customerID) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    // Verify vendor belongs to customer
    const vendor = await temporaryTransporterModel.findOne({
      _id: vendorId,
      customerID: customerID,
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found or access denied",
      });
    }

    // Reset zone matrix
    const updatedVendor = await temporaryTransporterModel.findByIdAndUpdate(
      vendorId,
      {
        "prices.priceChart": {},
        selectedZones: [],
      },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Zone matrix deleted successfully",
      data: {
        vendorId: updatedVendor._id,
        companyName: updatedVendor.companyName,
        priceChart: updatedVendor.prices.priceChart,
        selectedZones: updatedVendor.selectedZones,
      },
    });
  } catch (error) {
    console.error("Error deleting zone matrix:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while deleting zone matrix",
      error:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * Save wizard data to backend
 * POST /api/vendor/wizard-data
 */
export const saveWizardData = async (req, res) => {
  try {
    const { zones, priceMatrix, oda, other } = req.body;
    const customerID = req.customer?._id;

    if (!customerID) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    // Validate price matrix if provided
    if (priceMatrix && zones && Array.isArray(zones) && zones.length > 0) {
      const selectedZones = zones.map((z) => z.zoneCode).filter(Boolean);
      if (selectedZones.length > 0) {
        const matrixValidation = validateZoneMatrix(priceMatrix, selectedZones);
        if (!matrixValidation.valid) {
          return res.status(400).json({
            success: false,
            message: "Invalid zone matrix structure",
            errors: matrixValidation.errors,
          });
        }
      }
    }

    // For now, just acknowledge save; storage strategy can be plugged in later
    return res.status(200).json({
      success: true,
      message: "Wizard data saved successfully",
      data: {
        saved: true,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error saving wizard data:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while saving wizard data",
      error:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * Get wizard data from backend
 * GET /api/vendor/wizard-data
 */
export const getWizardData = async (req, res) => {
  try {
    const customerID = req.customer?._id;

    if (!customerID) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    // Placeholder empty structure
    return res.status(200).json({
      success: true,
      message: "Wizard data retrieved successfully",
      data: {
        zones: [],
        priceMatrix: {},
        oda: {
          enabled: false,
          pincodes: [],
          surcharge: { fixed: 0, variable: 0 },
        },
        other: {
          minWeight: 0,
          docketCharges: 0,
          fuel: 0,
          // ... other fields
        },
      },
    });
  } catch (error) {
    console.error("Error retrieving wizard data:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while retrieving wizard data",
      error:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ============================================================================
// DEBUG ENDPOINT - Check companyName field presence
// ============================================================================
export const debugVendorFields = async (req, res) => {
  try {
    const { customerID } = req.query;
    
    if (!customerID) {
      return res.status(400).json({
        success: false,
        message: "customerID is required"
      });
    }

    const vendors = await temporaryTransporterModel.find({
      customerID: customerID
    });

    const report = vendors.map(v => ({
      _id: v._id,
      hasCompanyName: !!(v.companyName && v.companyName.trim()),
      companyName: v.companyName || 'MISSING',
      vendorCode: v.vendorCode || 'N/A',
      vendorEmail: v.vendorEmail || 'N/A',
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }));

    const missing = report.filter(r => !r.hasCompanyName);
    const present = report.filter(r => r.hasCompanyName);

    res.json({
      success: true,
      summary: {
        total: vendors.length,
        withCompanyName: present.length,
        missingCompanyName: missing.length,
        percentageGood: vendors.length > 0 
          ? ((present.length / vendors.length) * 100).toFixed(1) + '%'
          : 'N/A'
      },
      allVendors: report,
      missingCompanyNameVendors: missing.length > 0 ? missing : null,
    });
  } catch (error) {
    console.error('Error in debugVendorFields:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
};

// ========================================================================
// SEARCH TEMPORARY TRANSPORTERS (for autocomplete)
// ========================================================================

/**
 * Search temporary transporters for autocomplete functionality
 * GET /api/transporter/search-transporters?query=dtdc&customerID=xxx&limit=10
 */
export const searchTemporaryTransporters = async (req, res) => {
  try {
    const { query, customerID, limit = 10 } = req.query;
    
    // Validate customerID
    if (!customerID) {
      return res.status(400).json({
        success: false,
        message: "Customer ID is required"
      });
    }

    // Require minimum 2 characters for search
    if (!query || query.length < 2) {
      return res.status(200).json({
        success: true,
        data: [],
        message: "Query must be at least 2 characters"
      });
    }

    // Escape special regex characters for safety
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(escapedQuery, 'i');

    // Search across multiple fields
    const transporters = await temporaryTransporterModel.find({
      customerID: customerID,
      $or: [
        { companyName: searchRegex },
        { legalCompanyName: searchRegex },
        { vendorCode: searchRegex }
      ]
    })
    .select({
      _id: 1,
      companyName: 1,
      legalCompanyName: 1,
      vendorCode: 1,
      vendorPhone: 1,
      vendorEmail: 1,
      gstNo: 1,
      mode: 1,
      serviceModes: 1,
      address: 1,
      state: 1,
      city: 1,
      pincode: 1,
      rating: 1,
      subVendor: 1,
      contactPerson: 1,
      primaryContactName: 1,
      primaryContactEmail: 1,
      primaryContactPhone: 1,
      selectedZones: 1,
      zoneConfig: 1,  // Include zoneConfig for autofill
      prices: 1,
      volumetricUnit: 1
    })
    .limit(Number(limit))
    .lean();

    // Helper: Extract zone codes from mixed array (strings or objects)
    const extractZoneCodes = (zones) => {
      if (!zones || !Array.isArray(zones)) return [];
      return zones.map(z => {
        if (typeof z === 'string') return z;
        if (typeof z === 'object' && z !== null) {
          return z.zoneCode || z.zone_code || z.code || null;
        }
        return null;
      }).filter(Boolean);
    };

    // Helper: Build empty price matrix structure from zone codes
    const buildEmptyPriceMatrix = (zoneCodes) => {
      if (!zoneCodes || zoneCodes.length === 0) return {};
      const matrix = {};
      for (const fromZone of zoneCodes) {
        matrix[fromZone] = {};
        for (const toZone of zoneCodes) {
          matrix[fromZone][toZone] = ''; // Empty for user to fill
        }
      }
      return matrix;
    };

    // Helper: Build pincode->city lookup from pincodeDataArray
    const pincodeToCityMap = {};
    for (const entry of pincodeDataArray) {
      const pin = String(entry.pincode || '').trim();
      if (pin) {
        pincodeToCityMap[pin] = {
          city: String(entry.city || '').trim(),
          state: String(entry.state || '').trim(),
        };
      }
    }

    // Helper: Convert zoneConfig pincodes to cities for wizard autofill
    const buildZoneCitiesFromConfig = (zoneConfig) => {
      if (!zoneConfig || typeof zoneConfig !== 'object') return {};
      
      const zoneCities = {};
      const entries = zoneConfig instanceof Map 
        ? Array.from(zoneConfig.entries())
        : Object.entries(zoneConfig);
      
      for (const [zoneCode, pincodes] of entries) {
        if (!Array.isArray(pincodes)) continue;
        
        // Get unique cities for this zone
        const citySet = new Set();
        const stateSet = new Set();
        
        for (const pin of pincodes) {
          const pinStr = String(pin).trim();
          const cityInfo = pincodeToCityMap[pinStr];
          if (cityInfo && cityInfo.city && cityInfo.state) {
            // Format: "CITY||STATE" for wizard
            const cityKey = `${cityInfo.city.toUpperCase()}||${cityInfo.state.toUpperCase()}`;
            citySet.add(cityKey);
            stateSet.add(cityInfo.state.toUpperCase());
          }
        }
        
        zoneCities[zoneCode] = {
          selectedCities: Array.from(citySet),
          selectedStates: Array.from(stateSet),
          pincodeCount: pincodes.length,
        };
      }
      
      return zoneCities;
    };

    // Format results for autocomplete dropdown
    const results = transporters.map(t => {
      const zones = extractZoneCodes(t.selectedZones);
      
      // Convert zoneConfig Map to plain object if needed
      let zoneConfigObj = {};
      if (t.zoneConfig) {
        if (t.zoneConfig instanceof Map) {
          zoneConfigObj = Object.fromEntries(t.zoneConfig);
        } else if (typeof t.zoneConfig === 'object') {
          zoneConfigObj = t.zoneConfig;
        }
      }
      
      // Build zone cities for wizard autofill
      const zoneCities = buildZoneCitiesFromConfig(t.zoneConfig);
      
      // Build full zone configs for wizard (with cities and states)
      const zoneConfigs = zones.map(zoneCode => {
        const cityData = zoneCities[zoneCode] || { selectedCities: [], selectedStates: [], pincodeCount: 0 };
        return {
          zoneCode: zoneCode,
          zoneName: zoneCode,
          region: zoneCode.startsWith('N') ? 'North' : 
                  zoneCode.startsWith('S') ? 'South' : 
                  zoneCode.startsWith('E') ? 'East' : 
                  zoneCode.startsWith('W') ? 'West' : 
                  zoneCode.startsWith('NE') ? 'Northeast' : 'Central',
          selectedStates: cityData.selectedStates,
          selectedCities: cityData.selectedCities,
          isComplete: cityData.selectedCities.length > 0,
        };
      });
      
      return {
        id: t._id.toString(),
        
        // Display info
        displayName: t.legalCompanyName || t.companyName,
        companyName: t.companyName || '',
        legalCompanyName: t.legalCompanyName || '',
        vendorCode: t.vendorCode || '',
        
        // Contact info
        vendorPhone: t.vendorPhone || '',
        vendorEmail: t.vendorEmail || '',
        contactPerson: t.contactPerson || '',
        primaryContactName: t.primaryContactName || t.contactPerson || '',
        primaryContactEmail: t.primaryContactEmail || '',
        primaryContactPhone: t.primaryContactPhone || '',
        
        // Company details
        gstNo: t.gstNo || '',
        subVendor: t.subVendor || '',
        
        // Location
        address: t.address || '',
        state: t.state || '',
        city: t.city || '',
        pincode: t.pincode || '',
        
        // Service
        mode: t.mode || 'road',
        serviceModes: t.serviceModes || '',
        rating: t.rating || 3,
        
        // Zones & Zone Config (for autofill)
        zones: zones,
        zoneConfig: zoneConfigObj,  // { N1: ["201301", "201302"], N2: [...] }
        zoneConfigs: zoneConfigs,   // Full wizard format with cities/states
        zoneMatrixStructure: buildEmptyPriceMatrix(zones),
        
        // Volumetric settings
        volumetricUnit: t.volumetricUnit || 'Centimeters',
        divisor: t.prices?.priceRate?.divisor || 5000,
        cftFactor: t.prices?.priceRate?.cftFactor || null,
      };
    });

    return res.status(200).json({
      success: true,
      data: results,
      count: results.length,
      query: query
    });

  } catch (error) {
    console.error('[searchTemporaryTransporters] Error:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to search transporters",
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};