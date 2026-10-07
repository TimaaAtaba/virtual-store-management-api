const Category = require("../models/Category");
const Product = require("../models/Product");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

/**
 * @desc    Create a new category
 * @route   POST /api/categories
 */
const createCategory = asyncHandler(async (req, res) => {
  const existing = await Category.findOne({ name: req.body.name });
  if (existing) throw new ApiError(409, "A category with this name already exists");

  const category = await Category.create(req.body);

  res.status(201).json({
    success: true,
    message: "Category created successfully",
    data: category,
  });
});

/**
 * @desc    Get all categories
 * @route   GET /api/categories
 */
const getCategories = asyncHandler(async (req, res) => {
  const categories = await Category.find().sort({ name: 1 });

  res.status(200).json({
    success: true,
    count: categories.length,
    data: categories,
  });
});

/**
 * @desc    Number of products in every category (aggregation + lookup)
 * @route   GET /api/categories/products-count
 */
const getProductsCountByCategory = asyncHandler(async (req, res) => {
  const stats = await Category.aggregate([
    {
      $lookup: {
        from: "products",
        localField: "_id",
        foreignField: "category",
        as: "products",
      },
    },
    {
      $project: {
        _id: 1,
        name: 1,
        description: 1,
        productsCount: { $size: "$products" },
        totalStock: { $sum: "$products.stock" },
      },
    },
    { $sort: { productsCount: -1, name: 1 } },
  ]);

  res.status(200).json({
    success: true,
    count: stats.length,
    data: stats,
  });
});

/**
 * @desc    Get a single category by id
 * @route   GET /api/categories/:id
 */
const getCategoryById = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) throw new ApiError(404, "Category not found");

  const productsCount = await Product.countDocuments({ category: category._id });

  res.status(200).json({
    success: true,
    data: { ...category.toObject(), productsCount },
  });
});

/**
 * @desc    Update a category
 * @route   PUT /api/categories/:id
 */
const updateCategory = asyncHandler(async (req, res) => {
  const category = await Category.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!category) throw new ApiError(404, "Category not found");

  res.status(200).json({
    success: true,
    message: "Category updated successfully",
    data: category,
  });
});

/**
 * @desc    Delete a category (only if it has no products)
 * @route   DELETE /api/categories/:id
 */
const deleteCategory = asyncHandler(async (req, res) => {
  const productsCount = await Product.countDocuments({ category: req.params.id });
  if (productsCount > 0) {
    throw new ApiError(
      400,
      `Cannot delete a category that contains ${productsCount} product(s)`
    );
  }

  const category = await Category.findByIdAndDelete(req.params.id);
  if (!category) throw new ApiError(404, "Category not found");

  res.status(200).json({
    success: true,
    message: "Category deleted successfully",
    data: category,
  });
});

module.exports = {
  createCategory,
  getCategories,
  getProductsCountByCategory,
  getCategoryById,
  updateCategory,
  deleteCategory,
};
