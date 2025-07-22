const { Client, Databases, Query } = require('node-appwrite');
const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async function (req, res) {
  try {
    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(req.variables.APPWRITE_ENDPOINT)
      .setProject(req.variables.APPWRITE_PROJECT_ID)
      .setKey(req.variables.APPWRITE_API_KEY);

    // Initialize Gemini AI
    const genAI = new GoogleGenerativeAI(req.variables.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const databases = new Databases(client);
    const userId = req.variables.APPWRITE_USER_ID;

    // Get user data
    const user = await databases.listDocuments(
      req.variables.DATABASE_ID,
      req.variables.TALENTS_COLLECTION_ID,
      [Query.equal("talentId", userId)]
    );

    if (user.documents.length === 0) {
      throw new Error("User not found");
    }

    const userData = user.documents[0];
    const careerStage = userData.careerStage;

    // Get all career paths
    const careerPaths = await databases.listDocuments(
      req.variables.DATABASE_ID,
      req.variables.CAREER_PATHS_COLLECTION_ID
    );

    // Prepare prompt based on career stage
    let prompt = `Based on the following user profile, recommend the top 3 career paths from the provided list. `;
    prompt += `User is a ${careerStage}.\n\n`;

    if (careerStage === "Pathfinder") {
      prompt += `User details:
      - Education: ${userData.degrees?.join(', ') || 'Not specified'}
      - Skills: ${userData.skills?.join(', ') || 'Not specified'}
      - Interests: ${userData.interests?.join(', ') || 'Not specified'}
      - Interested Fields: ${userData.interestedFields?.join(', ') || 'Not specified'}
      `;
    } else if (careerStage === "Trailblazer") {
      prompt += `User details:
      - Current Path: ${userData.currentPath || 'Not specified'}
      - Seniority Level: ${userData.currentSeniorityLevel || 'Not specified'}
      - Education: ${userData.degrees?.join(', ') || 'Not specified'}
      - Skills: ${userData.skills?.join(', ') || 'Not specified'}
      - Interests: ${userData.interests?.join(', ') || 'Not specified'}
      `;
    } else if (careerStage === "Horizon Changer") {
      prompt += `User details:
      - Current Path: ${userData.currentPath || 'Not specified'}
      - Seniority Level: ${userData.currentSeniorityLevel || 'Not specified'}
      - Education: ${userData.degrees?.join(', ') || 'Not specified'}
      - Skills: ${userData.skills?.join(', ') || 'Not specified'}
      - Interests: ${userData.interests?.join(', ') || 'Not specified'}
      - Interested Fields: ${userData.interestedFields?.join(', ') || 'Not specified'}
      `;
    }

    prompt += `\nAvailable Career Paths:\n`;
    careerPaths.documents.forEach(path => {
      prompt += `- ${path.title} (ID: ${path.$id}): ${path.description}\n`;
      prompt += `  Required Skills: ${path.requiredSkills?.join(', ') || 'None'}\n`;
      prompt += `  Required Interests: ${path.requiredInterests?.join(', ') || 'None'}\n`;
    });

    prompt += `\nProvide your response in JSON format with this structure:
    {
      "recommendations": [
        {
          "pathId": "career_path_id_1",
          "title": "Career Path Title 1",
          "matchScore": 90,
          "reason": "Detailed explanation why this is a good match",
          "improvementAreas": ["skill1", "skill2"]
        },
        ...
      ],
      "generalAdvice": "Overall career advice based on the user's profile"
    }`;

    // Get AI response
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Parse the JSON response
    let jsonResponse;
    try {
      jsonResponse = JSON.parse(text);
    } catch (e) {
      // If JSON parsing fails, try to extract JSON from text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonResponse = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("Failed to parse AI response");
      }
    }

    // Update user's testTaken status
    await databases.updateDocument(
      req.variables.DATABASE_ID,
      req.variables.TALENTS_COLLECTION_ID,
      userData.$id,
      {
        testTaken: true
      }
    );

    // Return the recommendations
    res.json({
      success: true,
      recommendations: jsonResponse.recommendations,
      generalAdvice: jsonResponse.generalAdvice,
      careerStage
    });
  } catch (error) {
    console.error("Error in careerMatch function:", error);
    res.json({
      success: false,
      error: error.message
    });
  }
};