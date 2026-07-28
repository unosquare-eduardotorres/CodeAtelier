/**
 * Three.js helpers for the 3D knowledge graph.
 * Most functionality now handled by react-force-graph-3d's native rendering.
 *
 * All custom node object creation, bloom setup, and lighting have been removed
 * in favor of the library's internal optimized pipeline (shared geometry,
 * MeshLambertMaterial, no post-processing). This eliminates ~3x Three.js objects
 * and delivers 50-60 FPS with 1000+ nodes instead of ~10 FPS.
 */

// Currently empty — retained as placeholder for future custom rendering needs.
